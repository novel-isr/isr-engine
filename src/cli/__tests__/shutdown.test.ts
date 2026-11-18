import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { ISRConfig } from '@/types';
import { shutdownServer, startAppServer } from '@/server/manager';

function config(): ISRConfig {
  return {
    renderMode: 'ssr',
    revalidate: 30,
    routes: {},
    ssg: {
      routes: [],
      concurrent: 1,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      failBuildThreshold: 0,
    },
    server: {
      port: state.port,
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
    },
  };
}

const state = vi.hoisted(() => ({
  closed: false,
  port: 0,
  closeError: undefined as Error | undefined,
}));
vi.mock('@/config/loadConfig', () => ({
  loadConfig: async () => config(),
}));
let finish!: () => void;
let url!: string;
vi.mock('@/server/productionRuntime', () => ({
  prepareProductionBuild: async () => ({}),
  createProductionRuntime: async () => {
    state.closed = false;
    const app = express();
    app.get('/', (_req, res) => {
      res.write('first');
      finish = () => {
        if (!res.writableEnded) res.end(state.closed ? 'resource closed' : 'last');
      };
    });
    return {
      app,
      close: async () => {
        state.closed = true;
        if (state.closeError) throw state.closeError;
      },
    };
  },
}));
import { startProductionServer } from '../start';
import * as http from '@/server/httpServer';

const signals: Array<[NodeJS.Signals, () => void]> = [];
afterEach(async () => {
  finish?.();
  await shutdownServer();
  state.port = 0;
  state.closeError = undefined;
  signals.forEach(([signal, listener]) => process.removeListener(signal, listener));
  signals.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('programmatic production drains HTTP before releasing runtime resources', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const context = await startAppServer(config(), () => {});
  const response = await fetch(context.url!);
  const body = response.text().catch(() => 'disconnected');
  const closing = shutdownServer();
  await Promise.resolve();
  await Promise.resolve();
  const closedBeforeDrain = state.closed;
  finish();
  await closing;
  expect(closedBeforeDrain).toBe(false);
  expect(await body).toBe('firstlast');
  expect(state.closed).toBe(true);
});

it('CLI signal shutdown drains HTTP before releasing runtime resources and exits successfully', async () => {
  const original = http.startServer;
  vi.spyOn(http, 'startServer').mockImplementation(async (...args) => {
    const result = await original(...args);
    url = result.url;
    return result;
  });
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM') signals.push([event, listener]);
    return on(event, listener);
  }) as typeof process.on);
  let exited!: (code: number) => void;
  const exit = new Promise<number>(resolve => {
    exited = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    exited(code);
  }) as never);
  await startProductionServer({});
  const response = await fetch(url);
  const body = response.text().catch(() => 'disconnected');
  signals.find(([signal]) => signal === 'SIGTERM')![1]();
  const closedBeforeDrain = state.closed;
  finish();
  expect(await exit).toBe(0);
  expect(closedBeforeDrain).toBe(false);
  expect(await body).toBe('firstlast');
  expect(state.closed).toBe(true);
});

it.each(['manager', 'CLI'])(
  'preserves %s listen failure when startup resource cleanup also fails',
  async mode => {
    vi.stubEnv('NODE_ENV', 'production');
    const occupied = await http.startHttp1Server(express(), { port: 0, host: '127.0.0.1' });
    state.port = Number(new URL(occupied.url).port);
    state.closeError = new Error('cleanup also failed');
    try {
      const started =
        mode === 'CLI' ? startProductionServer({}) : startAppServer(config(), () => {});
      await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(state.closed).toBe(true);
    } finally {
      await http.closeServer(occupied.server);
    }
  }
);
