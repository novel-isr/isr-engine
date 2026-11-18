import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { closeServer, startHttp1Server } from '../httpServer';

function createHandler(): Express {
  return ((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  }) as unknown as Express;
}

describe('httpServer enterprise hardening', () => {
  it('applies bounded HTTP/1.1 timeout defaults and serves requests', async () => {
    const app = createHandler();

    const { server, url } = await startHttp1Server(app, { port: 0 });
    try {
      const typed = server as typeof server & {
        requestTimeout: number;
        headersTimeout: number;
        keepAliveTimeout: number;
        maxRequestsPerSocket: number;
      };

      expect(typed.requestTimeout).toBe(60_000);
      expect(typed.headersTimeout).toBe(15_000);
      expect(typed.keepAliveTimeout).toBe(5_000);
      expect(typed.maxRequestsPerSocket).toBe(0);

      const response = await fetch(`${url}/health`);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await closeServer(server);
    }
  });

  it('keeps timeout hardening internal rather than reading public overrides', async () => {
    const app = createHandler();

    const { server } = await startHttp1Server(app, {
      port: 0,
    });

    try {
      const typed = server as typeof server & {
        requestTimeout: number;
        headersTimeout: number;
        keepAliveTimeout: number;
        maxRequestsPerSocket: number;
        __shutdownTimeoutMs?: number;
      };

      expect(typed.requestTimeout).toBe(60_000);
      expect(typed.headersTimeout).toBe(15_000);
      expect(typed.keepAliveTimeout).toBe(5_000);
      expect(typed.maxRequestsPerSocket).toBe(0);
      expect(typed.__shutdownTimeoutMs).toBe(5_000);
    } finally {
      await closeServer(server);
    }
  });

  it('uses strictPort=true to fail fast when the configured port is occupied', async () => {
    const app = createHandler();
    const occupied = await startHttp1Server(app, { port: 0, strictPort: true });
    const occupiedPort = Number(new URL(occupied.url).port);

    try {
      await expect(
        startHttp1Server(app, { port: occupiedPort, strictPort: true })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeServer(occupied.server);
    }
  });

  it('uses strictPort=false to try the next available local dev port', async () => {
    const app = createHandler();
    const occupied = await startHttp1Server(app, { port: 0, strictPort: true });
    const occupiedPort = Number(new URL(occupied.url).port);

    let fallback: Awaited<ReturnType<typeof startHttp1Server>> | null = null;
    try {
      fallback = await startHttp1Server(app, {
        port: occupiedPort,
        strictPort: false,
      });
      expect(Number(new URL(fallback.url).port)).toBeGreaterThan(occupiedPort);
    } finally {
      if (fallback) await closeServer(fallback.server);
      await closeServer(occupied.server);
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it('drains an active streamed response and shares concurrent closes', async () => {
  const entered = deferred<ServerResponse>();
  const { server, url } = await startHttp1Server(
    ((_req, res) => {
      res.write('first');
      entered.resolve(res);
    }) as Express,
    { port: 0, host: '127.0.0.1' }
  );
  const response = await fetch(url);
  const body = response.text().catch(() => 'disconnected');
  const res = await entered.promise;
  const closing = closeServer(server);
  try {
    expect(closeServer(server)).toBe(closing);
    expect(server.listening).toBe(false);
    res.end('last');
    await expect(body).resolves.toBe('firstlast');
    await closing;
  } finally {
    res.destroy();
    await closing;
  }
});

it('allows active work until the deadline then terminates its socket', async () => {
  const { server, url } = await startHttp1Server(
    ((_req, res) => {
      res.write('first');
    }) as Express,
    { port: 0, host: '127.0.0.1' }
  );
  (server as typeof server & { __shutdownTimeoutMs: number }).__shutdownTimeoutMs = 40;
  const response = await fetch(url);
  const body = response.text().then(
    () => 'completed',
    () => 'terminated'
  );
  const started = performance.now();
  await closeServer(server);
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
  expect(await body).toBe('terminated');
});

it('reports native listener close errors', async () => {
  await expect(closeServer(createServer())).rejects.toMatchObject({
    code: 'ERR_SERVER_NOT_RUNNING',
  });
});

it('bounds shutdown when an HTTP connection has been upgraded', async () => {
  const { server, url } = await startHttp1Server(createHandler(), { port: 0, host: '127.0.0.1' });
  (server as typeof server & { __shutdownTimeoutMs: number }).__shutdownTimeoutMs = 20;
  let upgraded!: Duplex;
  server.on('upgrade', (_req, socket) => {
    upgraded = socket;
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'
    );
  });
  const client = connect(Number(new URL(url).port), '127.0.0.1');
  await once(client, 'connect');
  client.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
  await once(client, 'data');
  let watchdog!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('HTTP shutdown exceeded its deadline')), 250);
  });
  const closing = closeServer(server);
  try {
    await Promise.race([closing, deadline]);
  } finally {
    clearTimeout(watchdog);
    client.destroy();
    upgraded.destroy();
    await closing;
  }
});
