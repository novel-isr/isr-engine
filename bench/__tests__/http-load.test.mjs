import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { measureHttp } from '../http-load.mjs';

const servers = [];

async function serve(handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/`, sockets };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise((resolve, reject) => {
          server.closeAllConnections();
          server.close(error => (error ? reject(error) : resolve()));
        })
    )
  );
});

const options = url => ({
  url,
  connections: 2,
  duration: 0.2,
  requestTimeoutMs: 1000,
  setupTimeoutMs: 1000,
  verifyBody: body => body.toString() === 'healthy',
});

async function expectClosed(sockets) {
  for (let i = 0; i < 100 && sockets.size; i++) await delay(5);
  expect(sockets.size).toBe(0);
}

describe('measureHttp', () => {
  it('waits for a verified first response on every connection before sending second requests', async () => {
    const counts = new Map();
    let release;
    let seenAll;
    const firstRequests = new Promise(resolve => {
      seenAll = resolve;
    });
    const { url, sockets } = await serve((request, response) => {
      const count = (counts.get(request.socket) ?? 0) + 1;
      counts.set(request.socket, count);
      if (counts.size === 3 && count === 1) {
        release = () => response.end('healthy');
        seenAll();
      } else {
        response.end('healthy');
      }
    });
    const measurement = measureHttp({ ...options(url), connections: 3 });
    await firstRequests;
    await delay(30);
    expect([...counts.values()]).toEqual([1, 1, 1]);
    release();
    const result = await measurement;
    expect(result.startup.primed_connections).toBe(3);
    expect(result.startup.setup_ms).toBeGreaterThanOrEqual(25);
    expect(result.requests.total).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(result.diagnostics.opened_connections).toBe(3);
    await expectClosed(sockets);
  });

  it('rejects invalid priming content and destroys all clients', async () => {
    const { url, sockets } = await serve((_request, response) => response.end('wrong'));
    const error = await measureHttp(options(url)).then(
      () => null,
      reason => reason
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.result.errors).toBeGreaterThan(0);
    expect(error.result.mismatches).toBeGreaterThan(0);
    expect(error.result.requests.total).toBe(0);
    await expectClosed(sockets);
  });

  it('reports native histogram samples and response body bytes for the timed window only', async () => {
    const { url, sockets } = await serve((_request, response) => response.end('healthy'));
    const result = await measureHttp(options(url));
    expect(result.errors).toBe(0);
    expect(result.timeouts).toBe(0);
    expect(result.mismatches).toBe(0);
    expect(result.non2xx).toBe(0);
    expect(result.requests.total).toBeGreaterThan(0);
    expect(result.requests.average).toBe(result.requests.total / 0.2);
    expect(result.throughput.average).toBe((result.requests.total * 7) / 0.2);
    expect(result.health_responses_total).toBeGreaterThanOrEqual(result.requests.total + 2);
    expect(result.latency.count).toBe(result.requests.total);
    expect(result.latency.p95).toBeGreaterThan(0);
    expect(result.latency.p95).toBeGreaterThanOrEqual(result.latency.p50);
    expect(result.latency.max).toBeGreaterThanOrEqual(result.latency.p99);
    expect(result.startup.primed_connections).toBe(2);
    await expectClosed(sockets);
  });

  it('enforces the setup deadline and cleans up healthy clients waiting at the barrier', async () => {
    let requests = 0;
    const { url, sockets } = await serve((_request, response) => {
      if (++requests === 1) response.end('healthy');
    });
    const error = await measureHttp({ ...options(url), setupTimeoutMs: 100 }).then(
      () => null,
      reason => reason
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.result.startup.primed_connections).toBe(1);
    expect(error.result.requests.total).toBe(0);
    expect(error.result.timeouts).toBeGreaterThan(0);
    await expectClosed(sockets);
  });

  it('drains a healthy late response without adding it to throughput or latency', async () => {
    let requests = 0;
    let release;
    let seenTimed;
    const timedRequest = new Promise(resolve => {
      seenTimed = resolve;
    });
    const { url, sockets } = await serve((_request, response) => {
      if (++requests === 1) return response.end('healthy');
      release = () => response.end('healthy');
      seenTimed();
    });
    const measurement = measureHttp({ ...options(url), connections: 1, duration: 0.025 });
    await timedRequest;
    await delay(50);
    release();
    const result = await measurement;
    expect(result.requests.total).toBe(0);
    expect(result.throughput.average).toBe(0);
    expect(result.latency.count).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.health_responses_total).toBe(2);
    await expectClosed(sockets);
  });

  it('counts a request timeout during drain while excluding its late completion from metrics', async () => {
    let requests = 0;
    const { url, sockets } = await serve((_request, response) => {
      if (++requests === 1) response.end('healthy');
    });
    const result = await measureHttp({
      ...options(url),
      connections: 1,
      duration: 0.025,
      requestTimeoutMs: 100,
    });
    expect(result.requests.total).toBe(0);
    expect(result.latency.count).toBe(0);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.timeouts).toBeGreaterThan(0);
    expect(result.timeouts).toBeLessThanOrEqual(result.errors);
    await expectClosed(sockets);
  });

  it.each([
    ['non-2xx', 503, 'healthy', 'non2xx'],
    ['body mismatch', 200, 'wrong', 'mismatches'],
  ])('counts a %s received after the timed window', async (_name, status, body, counter) => {
    let requests = 0;
    let release;
    let seenTimed;
    const timedRequest = new Promise(resolve => {
      seenTimed = resolve;
    });
    const lateRequest = new Promise(resolve => {
      release = resolve;
    });
    const { url, sockets } = await serve(async (_request, response) => {
      if (++requests === 1) return response.end('healthy');
      seenTimed();
      await lateRequest;
      response.statusCode = status;
      response.end(body);
    });
    const measurement = measureHttp({ ...options(url), connections: 1, duration: 0.025 });
    await timedRequest;
    await delay(50);
    release();
    const result = await measurement;
    expect(result.requests.total).toBe(0);
    expect(result[counter]).toBe(1);
    expect(result.health_responses_total).toBe(2);
    expect(result.errors).toBeGreaterThan(0);
    await expectClosed(sockets);
  });

  it('counts loss of a primed connection and subsequent reconnection as unhealthy', async () => {
    let requests = 0;
    const { url, sockets } = await serve((_request, response) => {
      if (++requests === 2) response.setHeader('connection', 'close');
      response.end('healthy');
    });
    const result = await measureHttp({ ...options(url), connections: 1 });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.diagnostics.opened_connections).toBeGreaterThan(1);
    expect(result.diagnostics.connection_samples.some(sample => sample.event === 'connect')).toBe(
      true
    );
    await expectClosed(sockets);
  });

  it('supports multiple closed loops on each pipelined connection', async () => {
    const counts = new Map();
    let maxInFlight = 0;
    let inFlight = 0;
    const { url, sockets } = await serve((request, response) => {
      const count = (counts.get(request.socket) ?? 0) + 1;
      counts.set(request.socket, count);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      setTimeout(() => {
        inFlight--;
        response.end('healthy');
      }, 5);
    });
    const result = await measureHttp({ ...options(url), connections: 1, pipelining: 3 });
    expect(result.errors).toBe(0);
    expect(result.startup.primed_connections).toBe(1);
    expect(result.diagnostics.opened_connections).toBe(1);
    expect(maxInFlight).toBe(3);
    await expectClosed(sockets);
  });
});
