import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ISRConfig } from '@/types';
import * as exposure from '@/experiments/ExposureQueue';

const transport = vi.hoisted(() => ({
  createViteDevServer: vi.fn(),
  closeViteDevServer: vi.fn(),
  startServer: vi.fn(),
  closeServer: vi.fn(),
}));
vi.mock('../viteDevServer', () => ({
  createViteDevServer: transport.createViteDevServer,
  closeViteDevServer: transport.closeViteDevServer,
}));
vi.mock('../httpServer', () => ({
  startServer: transport.startServer,
  closeServer: transport.closeServer,
}));

import { shutdownServer, startAppServer } from '../manager';

function config(): ISRConfig {
  return {
    renderMode: 'isr',
    revalidate: 30,
    routes: {},
    ssg: {
      routes: [],
      concurrent: 3,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      failBuildThreshold: 0,
    },
    server: {
      port: 0,
      host: '127.0.0.1',
      strictPort: true,
      ops: {
        authToken: undefined,
        tokenHeader: 'x-isr-admin-token',
        health: { enabled: true, public: true },
        metrics: { enabled: false, public: false },
        inventory: { enabled: false, public: false },
      },
    },
    runtime: {
      site: undefined,
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,
      telemetry: false,
      experimentManifest: {
        endpoint: 'https://manifest.test/experiments',
        refreshIntervalMs: 1000,
        fallbackOnError: 'cache',
        authHeader: undefined,
      },
      experimentTracking: {
        endpoint: 'https://manifest.test/exposures',
        batchSize: 10,
        flushIntervalMs: 1000,
        sampleRate: 1,
        enabled: true,
      },
    },
  };
}

let queues: exposure.ExposureQueueInstance[];
let fetcher: ReturnType<typeof vi.fn>;
let listeners: number[];
const signals = ['SIGTERM', 'SIGINT', 'beforeExit'] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'development');
  vi.clearAllMocks();
  transport.createViteDevServer.mockResolvedValue({
    middlewares: (_req: unknown, _res: unknown, next: () => void) => next(),
  });
  transport.closeViteDevServer.mockResolvedValue(undefined);
  transport.startServer.mockResolvedValue({ server: {}, url: 'http://test.invalid' });
  transport.closeServer.mockResolvedValue(undefined);
  fetcher = vi.fn(async () => Response.json({ experiments: {} }));
  vi.stubGlobal('fetch', fetcher);
  queues = [];
  const resolve = exposure.resolveExposureQueue;
  vi.spyOn(exposure, 'resolveExposureQueue').mockImplementation((...args) => {
    const queue = resolve(...args);
    if (queue) queues.push(queue);
    return queue;
  });
  listeners = signals.map(signal => process.listenerCount(signal));
});

afterEach(async () => {
  await shutdownServer();
  // Prevent a failing regression from leaking its old resources into another case.
  queues.forEach(queue => queue.destroy());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('stops real manifest polling and releases exposure hooks after awaited shutdown', async () => {
  await startAppServer(config(), () => {});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(queues).toHaveLength(1);
  await shutdownServer();
  await vi.advanceTimersByTimeAsync(2100);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(signals.map(signal => process.listenerCount(signal))).toEqual(listeners);
  expect(transport.closeViteDevServer).toHaveBeenCalledTimes(1);
});

it('drains pending exposure events before destroying the owned queue', async () => {
  await startAppServer(config(), () => {});
  queues[0].push({
    anonId: 'anonymous',
    userId: null,
    requestId: 'request',
    experiments: { hero: 'control' },
    path: '/',
    ts: Date.now(),
  });
  await shutdownServer();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe('https://manifest.test/exposures');
  await vi.advanceTimersByTimeAsync(2100);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(queues[0].size).toBe(0);
});

it.each(['routes', 'listen'] as const)(
  'rolls back owned resources on %s startup failure',
  async phase => {
    const failure = new Error('startup rejected');
    if (phase === 'listen') transport.startServer.mockRejectedValueOnce(failure);
    await expect(
      startAppServer(config(), () => {
        if (phase === 'routes') throw failure;
      })
    ).rejects.toBe(failure);
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(listeners);
    expect(transport.closeViteDevServer).toHaveBeenCalledTimes(1);
    await startAppServer(config(), () => {});
    expect(transport.createViteDevServer).toHaveBeenCalledTimes(2);
  }
);

it('shares concurrent shutdown and waits for it before starting a new development runtime', async () => {
  await startAppServer(config(), () => {});
  let release!: () => void;
  transport.closeViteDevServer.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      })
  );
  const stopping = shutdownServer();
  const duplicate = shutdownServer();
  expect(duplicate).toBe(stopping);
  await vi.advanceTimersByTimeAsync(0);
  const restarting = startAppServer(config(), () => {});
  expect(transport.createViteDevServer).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([stopping, duplicate, restarting]);
  expect(transport.createViteDevServer).toHaveBeenCalledTimes(2);
});
