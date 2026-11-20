import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

test('import and require share the public Node module instances', async () => {
  for (const [specifier, names] of [
    ['isr-engine', ['createCoherentCacheStore', 'Logger']],
    ['isr-engine/adapters/runtime', ['toCloudflareWorker']],
    ['isr-engine/config', ['defineIsrConfig', 'defineRuntimeConfig', 'withLocale', 'alternates']],
    [
      'isr-engine/auto-observability',
      ['createAutoServerHooks', 'composeAutoServerHooks', 'resolveSentryDsnFromEnv'],
    ],
  ]) {
    const commonjs = require(specifier);
    const esm = await import(specifier);
    for (const name of names) {
      assert.equal(typeof esm[name], 'function', specifier + ':' + name);
      assert.equal(commonjs[name], esm[name], specifier + ':' + name);
    }
  }
});

test('the installed engine builds and serves the documented app', async () => {
  process.env.NODE_ENV = 'production';
  const { createISRApp, invalidatorRunsTotal, loadConfig } = await import('isr-engine');
  const { revalidateContent, revalidateTag } = require('isr-engine/rsc');
  const { Logger } = require('isr-engine');
  Logger.getInstance({ verbose: true }).debug('CommonJS consumer logging');
  const config = await loadConfig();
  config.server.host = '127.0.0.1';
  config.server.port = 0;
  let sitemapEntries = [
    { path: '/about', status: 'published', modifiedTime: '2026-10-01T08:00:00Z' },
    { path: '/guides/rendering', status: 'unpublished' },
  ];
  let sitemapLoads = 0;
  config.runtime.seo = {
    ...config.runtime.seo,
    sitemap: {
      load: async () => {
        sitemapLoads++;
        return sitemapEntries;
      },
    },
  };
  const app = await createISRApp(config);
  try {
    const { url } = await app.start();
    for (const [route, title] of [
      ['/', 'Hello, isr-engine'],
      ['/about', 'About'],
      ['/guides/rendering', 'Rendering guide'],
    ]) {
      const response = await fetch(url + route, {
        headers: { 'x-request-id': 'artifact-request' },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.ok(html.includes(`<h1>${title}</h1>`), route);
      assert.ok(
        html.includes(`<title data-isr-seo>${title}</title>`),
        `Missing SEO title for ${route}`
      );
      const canonical = new URL(route, config.runtime.site).href;
      assert.ok(
        html.includes(`<link data-isr-seo rel="canonical" href="${canonical}">`),
        'Missing canonical URL for ' + route
      );
      assert.ok(
        html.includes(`<link data-isr-seo rel="alternate" hreflang="en" href="${canonical}">`),
        'Missing English alternate URL for ' + route
      );
      if (route === '/guides/rendering') {
        assert.match(
          response.headers.get('server-timing') ?? '',
          /^isr;dur=\d+;desc="artifact-request"$/
        );
      }
    }
    await revalidateTag('hello-home');
    const metric = await invalidatorRunsTotal.get();
    assert.equal(
      metric.values.find(({ labels }) => labels.kind === 'tag' && labels.target === 'hello-home')
        ?.value,
      1
    );

    const readSitemap = async () => {
      const response = await fetch(url + '/sitemap.xml', { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      return response.text();
    };
    const initial = await readSitemap();
    assert.ok(initial.includes(new URL('/about', config.runtime.site).href));
    assert.ok(initial.includes('<lastmod>2026-10-01T08:00:00.000Z</lastmod>'));
    assert.ok(!initial.includes('/guides/rendering'));

    sitemapEntries = [
      { path: '/about', status: 'published', noindex: true },
      { path: '/guides/rendering', status: 'published' },
    ];
    assert.equal(await readSitemap(), initial);
    assert.equal(sitemapLoads, 1);
    await revalidateContent({ paths: ['/about', '/guides/rendering'], sitemap: true });
    const updated = await readSitemap();
    assert.ok(!updated.includes('/about'));
    assert.ok(!updated.includes('<lastmod>'));
    assert.ok(updated.includes(new URL('/guides/rendering', config.runtime.site).href));
    assert.equal(sitemapLoads, 2);
  } finally {
    await app.shutdown();
  }
});
