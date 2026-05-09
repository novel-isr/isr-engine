import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveClientObservabilityOptions } from '../clientObservabilityConfig';
import type { ISRConfig } from '../../types';

const roots: string[] = [];

function runtime(overrides: Record<string, unknown> = {}): ISRConfig['runtime'] {
  const services = overrides.services as Partial<ISRConfig['runtime']['services']> | undefined;
  return {
    site: undefined,
    redis: undefined,
    rateLimit: false,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    theme: undefined,
    telemetry: false,
    ...overrides,
    services: { api: undefined, telemetry: undefined, ...services },
  } as ISRConfig['runtime'];
}

describe('resolveClientObservabilityOptions', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('returns null when runtime.telemetry is not configured', () => {
    expect(resolveClientObservabilityOptions({})).toBeNull();
  });

  it('returns false when browser telemetry is explicitly disabled', () => {
    expect(resolveClientObservabilityOptions({ runtime: runtime({ telemetry: false }) })).toBe(
      false
    );
  });

  it('serializes only browser-safe telemetry options and joins service origin', async () => {
    const root = await createRoot('novel-rating');
    const options = resolveClientObservabilityOptions({
      root,
      env: {
        NODE_ENV: 'production',
        VITE_APP_VERSION: '1.2.3',
      } as NodeJS.ProcessEnv,
      runtime: runtime({
        redis: {
          url: 'redis://secret@localhost:6379/0',
          host: undefined,
          port: undefined,
          password: undefined,
          keyPrefix: undefined,
          invalidationChannel: undefined,
        },
        services: {
          api: 'https://admin.example.com',
          telemetry: 'https://rum.example.com',
        },
        telemetry: {
          app: undefined,
          release: undefined,
          environment: undefined,
          includeQueryString: false,
          events: {
            endpoint: '/ingest/events',
            sampleRate: undefined,
            batchSize: 12,
            flushIntervalMs: undefined,
            maxQueueSize: 120,
            retryBaseDelayMs: 500,
            retryMaxDelayMs: 5000,
            trackInitialPage: undefined,
          },
          errors: {
            endpoint: '/ingest/errors',
            sampleRate: 0.5,
            batchSize: undefined,
            flushIntervalMs: undefined,
            maxQueueSize: 80,
            retryBaseDelayMs: 1000,
            retryMaxDelayMs: 10000,
            captureResourceErrors: true,
          },
          webVitals: { enabled: true },
          exporters: [],
          integrations: {
            sentry: {
              enabled: true,
              dsn: 'https://private@sentry.example/1',
              tracesSampleRate: undefined,
              environment: undefined,
              release: undefined,
            },
          },
        },
      }),
    });

    expect(options).toEqual({
      app: 'novel-rating',
      release: '1.2.3',
      environment: 'production',
      includeQueryString: false,
      analytics: {
        endpoint: 'https://rum.example.com/ingest/events',
        sampleRate: undefined,
        batchSize: 12,
        flushIntervalMs: undefined,
        maxQueueSize: 120,
        retryBaseDelayMs: 500,
        retryMaxDelayMs: 5000,
        webVitals: true,
        trackInitialPage: undefined,
      },
      errorReporting: {
        endpoint: 'https://rum.example.com/ingest/errors',
        sampleRate: 0.5,
        batchSize: undefined,
        flushIntervalMs: undefined,
        maxQueueSize: 80,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 10000,
        captureResourceErrors: true,
      },
    });
    expect(JSON.stringify(options)).not.toContain('redis://');
    expect(JSON.stringify(options)).not.toContain('sentry.example');
  });

  it('uses same-origin default endpoints when service origin is empty', () => {
    const options = resolveClientObservabilityOptions({
      runtime: runtime({
        telemetry: {
          app: 'app',
          release: undefined,
          environment: undefined,
          includeQueryString: false,
          events: {
            endpoint: undefined,
            sampleRate: undefined,
            batchSize: undefined,
            flushIntervalMs: undefined,
            maxQueueSize: undefined,
            retryBaseDelayMs: undefined,
            retryMaxDelayMs: undefined,
            trackInitialPage: undefined,
          },
          errors: {
            endpoint: undefined,
            sampleRate: undefined,
            batchSize: undefined,
            flushIntervalMs: undefined,
            maxQueueSize: undefined,
            retryBaseDelayMs: undefined,
            retryMaxDelayMs: undefined,
            captureResourceErrors: true,
          },
          webVitals: { enabled: true },
          exporters: [],
          integrations: { sentry: undefined },
          traceDebug: undefined,
        },
      }),
    });

    if (!options) throw new Error('expected browser observability options');

    expect(options.analytics).toMatchObject({
      endpoint: '/api/observability/analytics',
    });
    expect(options.errorReporting).toMatchObject({
      endpoint: '/api/observability/errors',
    });
  });

  it('events/errors endpoint 是第一方 HTTP 上报的唯一真值源', () => {
    const options = resolveClientObservabilityOptions({
      runtime: runtime({
        services: { telemetry: 'https://admin.example.com' },
        telemetry: {
          app: 'app',
          release: undefined,
          environment: undefined,
          includeQueryString: false,
          events: {
            endpoint: '/api/telemetry/events',
            sampleRate: undefined,
            batchSize: undefined,
            flushIntervalMs: undefined,
            maxQueueSize: undefined,
            retryBaseDelayMs: undefined,
            retryMaxDelayMs: undefined,
            trackInitialPage: undefined,
          },
          errors: {
            endpoint: '/api/telemetry/errors',
            sampleRate: undefined,
            batchSize: undefined,
            flushIntervalMs: undefined,
            maxQueueSize: undefined,
            retryBaseDelayMs: undefined,
            retryMaxDelayMs: undefined,
            captureResourceErrors: true,
          },
          webVitals: false,
          exporters: [],
          integrations: { sentry: undefined },
          traceDebug: undefined,
        },
      }),
    });

    if (!options) throw new Error('expected browser telemetry options');

    expect(options.analytics).toMatchObject({
      endpoint: 'https://admin.example.com/api/telemetry/events',
    });
    expect(options.errorReporting).toMatchObject({
      endpoint: 'https://admin.example.com/api/telemetry/errors',
    });
  });
});

async function createRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-client-observability-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name }, null, 2));
  return root;
}
