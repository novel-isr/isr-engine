import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const state = vi.hoisted(() => ({
  addresses: [{ address: '8.8.8.8', family: 4 }],
  status: 200,
  headers: {} as Record<string, string>,
  body: Buffer.from('image'),
  stalled: false,
  dnsStalled: false,
  calls: 0,
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => (state.dnsStalled ? new Promise<never>(() => {}) : state.addresses)),
}));
vi.mock('node:http', () => ({
  request: (
    _url: URL,
    options: {
      signal: AbortSignal;
      lookup(
        host: string,
        options: { all: boolean },
        callback: (error: unknown, addresses: unknown) => void
      ): void;
    },
    callback: (response: unknown) => void
  ) => {
    state.calls++;
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => {
      options.lookup('rebound.invalid', { all: true }, (_error: unknown, addresses: unknown) => {
        expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
      });
      if (!state.stalled) {
        const response = Object.assign(Readable.from([state.body]), {
          statusCode: state.status,
          headers: state.headers,
          complete: true,
        });
        response.statusCode = state.status;
        response.headers = state.headers;
        response.complete = true;
        callback(response);
      }
    };
    options.signal.addEventListener('abort', () => request.emit('error', new Error('aborted')), {
      once: true,
    });
    return request;
  },
}));
import { fetchRemoteImage } from '../remoteImageSource';
afterEach(() => {
  state.addresses = [{ address: '8.8.8.8', family: 4 }];
  state.status = 200;
  state.headers = {};
  state.body = Buffer.from('image');
  state.stalled = false;
  state.dnsStalled = false;
  state.calls = 0;
  vi.useRealTimers();
});
describe('remote image request policy', () => {
  it('connects using the validated answer without a second DNS resolution', async () => {
    expect(await fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)).toEqual(
      Buffer.from('image')
    );
    expect(state.calls).toBe(1);
  });
  it('rejects a private DNS answer before starting a request', async () => {
    state.addresses = [{ address: '127.0.0.1', family: 4 }];
    await expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toThrow('source address not allowed');
    expect(state.calls).toBe(0);
  });
  it('checks redirects before connecting to the next host', async () => {
    state.status = 302;
    state.headers = { location: 'http://blocked.test/a' };
    await expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toThrow('source origin not allowed');
    expect(state.calls).toBe(1);
  });
  it('bounds bytes received without trusting content length', async () => {
    state.body = Buffer.alloc(11);
    await expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toMatchObject({ status: 413 });
  });
  it('includes DNS resolution in the total timeout', async () => {
    vi.useFakeTimers();
    state.dnsStalled = true;
    const pending = expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(state.calls).toBe(0);
  });
  it('bounds allowed redirect chains', async () => {
    state.status = 302;
    state.headers = { location: '/again' };
    await expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toThrow('invalid source redirect');
    expect(state.calls).toBe(6);
  });
  it('times out stalled upstream connections', async () => {
    vi.useFakeTimers();
    state.stalled = true;
    const pending = expect(
      fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)
    ).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
  });
});
