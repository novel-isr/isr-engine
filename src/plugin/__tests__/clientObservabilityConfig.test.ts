import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveClientObservabilityOptions } from '../clientObservabilityConfig';

const roots: string[] = [];

describe('resolveClientObservabilityOptions', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('returns null when runtime.telemetry is not configured', () => {
    expect(resolveClientObservabilityOptions({ runtime: {} })).toBeNull();
  });

  it('returns false when browser telemetry is explicitly disabled', () => {
    expect(resolveClientObservabilityOptions({ runtime: { telemetry: false } })).toBe(false);
  });

  it('serializes only browser-safe telemetry options and joins service origin', async () => {
    const root = await createRoot('novel-rating');
    const options = resolveClientObservabilityOptions({
      root,
      env: {
        NODE_ENV: 'production',
        VITE_APP_VERSION: '1.2.3',
      } as NodeJS.ProcessEnv,
      runtime: {
        redis: { url: 'redis://secret@localhost:6379/0' },
        services: {
          api: 'https://admin.example.com',
          telemetry: 'https://rum.example.com',
        },
        telemetry: {
          includeQueryString: false,
          events: {
            endpoint: '/ingest/events',
            batchSize: 12,
            maxQueueSize: 120,
            retryBaseDelayMs: 500,
            retryMaxDelayMs: 5000,
          },
          errors: {
            endpoint: '/ingest/errors',
            sampleRate: 0.5,
            maxQueueSize: 80,
            retryBaseDelayMs: 1000,
            retryMaxDelayMs: 10000,
          },
          exporters: [{ type: 'sentry', dsn: 'https://private@sentry.example/1' }],
        },
      },
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
      runtime: { telemetry: { app: 'app' } },
    });

    if (!options) throw new Error('expected browser observability options');

    expect(options.analytics).toMatchObject({
      endpoint: '/api/observability/analytics',
    });
    expect(options.errorReporting).toMatchObject({
      endpoint: '/api/observability/errors',
    });
  });

  it('can read first-party endpoint paths from the http exporter', () => {
    const options = resolveClientObservabilityOptions({
      runtime: {
        services: { telemetry: 'https://admin.example.com' },
        telemetry: {
          app: 'app',
          exporters: [
            {
              type: 'http',
              name: 'admin-server',
              endpoints: {
                events: '/api/telemetry/events',
                errors: '/api/telemetry/errors',
              },
            },
          ],
        },
      },
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
