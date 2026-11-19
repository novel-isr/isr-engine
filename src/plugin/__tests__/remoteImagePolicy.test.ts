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
  resolvedHosts: [] as string[],
  requests: [] as Array<Record<string, unknown>>,
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    state.resolvedHosts.push(hostname);
    return state.dnsStalled ? new Promise<never>(() => {}) : state.addresses;
  }),
}));
vi.mock('node:http', () => ({
  request: (
    options: {
      hostname: string;
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
    state.requests.push(options as unknown as Record<string, unknown>);
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
vi.mock('node:https', async () => await vi.importMock('node:http'));
import { fetchRemoteImage } from '../remoteImageSource';
afterEach(() => {
  state.addresses = [{ address: '8.8.8.8', family: 4 }];
  state.status = 200;
  state.headers = {};
  state.body = Buffer.from('image');
  state.stalled = false;
  state.dnsStalled = false;
  state.calls = 0;
  state.resolvedHosts = [];
  state.requests = [];
  vi.useRealTimers();
});
describe('remote image request policy', () => {
  it('connects using the validated answer without a second DNS resolution', async () => {
    expect(await fetchRemoteImage('http://allowed.test/a', new Set(['allowed.test']), 10)).toEqual(
      Buffer.from('image')
    );
    expect(state.calls).toBe(1);
    expect(state.resolvedHosts).toEqual(['allowed.test']);
    expect(state.requests[0]).toMatchObject({
      protocol: 'http:',
      hostname: 'allowed.test',
      port: 80,
      path: '/a',
      agent: false,
      headers: { host: 'allowed.test' },
    });
  });
  it('keeps a configured TLS identity and explicit port separate from the requested path and query', async () => {
    await fetchRemoteImage(
      'https://ALLOWED.test:8443/a?x=1#ignored',
      new Set(['allowed.test:8443']),
      10
    );
    expect(state.requests[0]).toMatchObject({
      protocol: 'https:',
      hostname: 'allowed.test',
      port: 8443,
      path: '/a?x=1',
      servername: 'allowed.test',
      rejectUnauthorized: true,
      headers: { host: 'allowed.test:8443' },
    });
  });
  it('treats a network-path-looking pathname as a path on the configured origin', async () => {
    await fetchRemoteImage(
      'http://allowed.test//evil.test/a?src=http://127.0.0.1/',
      new Set(['allowed.test']),
      10
    );
    expect(state.requests[0]).toMatchObject({
      hostname: 'allowed.test',
      path: '//evil.test/a?src=http://127.0.0.1/',
    });
    expect(state.resolvedHosts).toEqual(['allowed.test']);
  });
  it.each(['http://user@allowed.test/a', 'https://allowed.test:8443/a', 'http://other.test/a'])(
    'rejects an unapproved authority before connecting: %s',
    async source => {
      await expect(fetchRemoteImage(source, new Set(['allowed.test']), 10)).rejects.toThrow(
        'source origin not allowed'
      );
      expect(state.calls).toBe(0);
    }
  );
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
