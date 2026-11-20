import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

test('public Node exports resolve as ESM and CommonJS', async () => {
  for (const [specifier, names] of [
    ['isr-engine', ['createCoherentCacheStore', 'Logger']],
    [
      'isr-engine/auto-observability',
      ['createAutoServerHooks', 'composeAutoServerHooks', 'resolveSentryDsnFromEnv'],
    ],
  ]) {
    const esm = await import(specifier);
    const commonjs = require(specifier);
    for (const name of names) {
      assert.equal(typeof esm[name], 'function', specifier + ':' + name);
      assert.equal(typeof commonjs[name], 'function', specifier + ':' + name);
    }
  }
});

test('the installed engine builds and serves the documented app', async () => {
  process.env.NODE_ENV = 'production';
  const { createISRApp, invalidatorRunsTotal, loadConfig } = await import('isr-engine');
  const { revalidateTag } = await import('isr-engine/rsc');
  const config = await loadConfig();
  config.server.host = '127.0.0.1';
  config.server.port = 0;
  const app = await createISRApp(config);
  try {
    const { url } = await app.start();
    for (const [route, title] of [
      ['/', 'Hello, isr-engine'],
      ['/about', 'About'],
      ['/guides/rendering', 'Rendering guide'],
    ]) {
      const response = await fetch(url + route, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.ok(html.includes(`<h1>${title}</h1>`), route);
      assert.ok(html.includes(`<title>${title}</title>`), `Missing SEO title for ${route}`);
    }
    await revalidateTag('hello-home');
    const metric = await invalidatorRunsTotal.get();
    assert.equal(
      metric.values.find(({ labels }) => labels.kind === 'tag' && labels.target === 'hello-home')
        ?.value,
      1
    );
  } finally {
    await app.shutdown();
  }
});
