import type { IncomingMessage, ServerResponse } from 'node:http';
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
});
