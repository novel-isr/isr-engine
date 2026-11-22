import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import express from 'express';
import { createCspNonceMiddleware, createSecurityMiddleware } from '../../src/server/middleware';

import { browserTest, interceptRequests, startBrowserServer } from '../browser';

let server: Awaited<ReturnType<typeof startBrowserServer>>;

beforeAll(async () => {
  server = await startBrowserServer('production');
});

afterAll(async () => {
  await server?.close();
});

function productionUrl(path: string) {
  return new URL(path, server.origin).href;
}

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error =>
    errors.push(error instanceof Error ? error.message : String(error))
  );
  page.on('console', message => {
    if (message.type() === 'error') {
      const { url } = message.location();
      errors.push(url ? `${message.text()} (${url})` : message.text());
    }
  });
  return errors;
}

const checkedBrowserTest = browserTest.extend('checkedPage', ({ page }, { onCleanup }) => {
  const errors = collectBrowserErrors(page);
  onCleanup(() => expect(errors).toEqual([]));
  return page;
});

const initialCount = '::-p-aria([name="Count 0"][role="button"])';
const incrementedCount = '::-p-aria([name="Count 1"][role="button"])';
const articleHeading = '::-p-aria([name="Article"][role="heading"])';
const homeHeading = '::-p-aria([name="Home"][role="heading"])';

async function waitForHydratedCounter(page: Page) {
  await page.waitForFunction(
    () => document.querySelector('main button:enabled')?.textContent === 'Count 0'
  );
}

async function incrementCounter(page: Page) {
  await page.locator(initialCount).click();
  await page.waitForSelector(incrementedCount, { visible: true });
}

async function cacheStatus(url: string) {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.headers.get('x-cache-status');
}

function startProgrammaticApp(env: NodeJS.ProcessEnv) {
  const child = fork(fileURLToPath(new URL('./programmatic-server.mjs', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', chunk => (output += String(chunk)));
  child.stderr!.on('data', chunk => (output += String(chunk)));
  const ready = new Promise<string>((resolve, reject) => {
    child.once('message', message => resolve((message as { ready: string }).ready));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Production app exited ${code}: ${output}`)));
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    ready,
    exited,
    get output() {
      return output;
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

checkedBrowserTest(
  'data and Blob images load under both development and production image policies',
  async ({ checkedPage: page }) => {
    for (const isDev of [true, false]) {
      const app = express();
      app.use(createCspNonceMiddleware(), createSecurityMiddleware(isDev));
      app.get('/favicon.ico', (_req, res) => {
        res.status(204).end();
      });
      app.get('/', (_req, res) => {
        res
          .type('html')
          .send(
            '<!doctype html><html><head><title>Image policy</title></head><body></body></html>'
          );
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
        const response = await page.goto(`http://127.0.0.1:${address.port}/`);
        expect(response?.headers()['strict-transport-security']).toBe(
          isDev ? undefined : 'max-age=15552000; includeSubDomains'
        );
        const loaded = await page.evaluate(async () => {
          const base64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=';
          const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          const blob = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
          try {
            return await Promise.all(
              [`data:image/png;base64,${base64}`, blob].map(
                src =>
                  new Promise<boolean>(resolve => {
                    const image = new Image();
                    image.onload = () => resolve(true);
                    image.onerror = () => resolve(false);
                    image.src = src;
                    document.body.append(image);
                  })
              )
            );
          } finally {
            URL.revokeObjectURL(blob);
          }
        });
        expect(loaded).toEqual([true, true]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  }
);

checkedBrowserTest(
  'SSR controls become actionable only after their client modules hydrate',
  async ({ checkedPage: page }) => {
    let releaseModules!: () => void;
    let reportBlockedModule!: () => void;
    const modulesReady = new Promise<void>(resolve => {
      releaseModules = resolve;
    });
    const moduleBlocked = new Promise<void>(resolve => {
      reportBlockedModule = resolve;
    });
    const removeInterception = await interceptRequests(page, async request => {
      if (/\/assets\/.*\.js(?:\?|$)/.test(request.url())) {
        reportBlockedModule();
        await modulesReady;
        await request.continue();
      }
    });
    const navigation = page.goto(productionUrl('/static?hydration-contract=1'));
    const localeLink = '::-p-aria([name="中文"][role="link"])';
    try {
      await Promise.race([
        moduleBlocked,
        navigation.then(() => {
          throw new Error('The page loaded without requesting a blocked client module');
        }),
      ]);
      await page.waitForSelector(initialCount, { visible: true });
      expect(await page.$eval(initialCount, button => button.hasAttribute('disabled'))).toBe(true);
      await page.waitForSelector(localeLink, { visible: true });
      expect(await page.$eval(localeLink, link => link.getAttribute('aria-disabled'))).toBe('true');
      expect(await page.$eval(localeLink, link => link.getAttribute('href'))).toBeNull();
      releaseModules();
      await navigation;
      await waitForHydratedCounter(page);
      await expect
        .poll(() => page.$eval(localeLink, link => link.getAttribute('aria-disabled')))
        .toBeNull();
      await incrementCounter(page);
    } finally {
      releaseModules();
      await removeInterception();
    }
  }
);

checkedBrowserTest(
  'SSG with a query hydrates under its CSP and supports RSC navigation',
  async ({ checkedPage: page }) => {
    const response = await page.goto(productionUrl('/static?search=a.b'));
    expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
    expect(response?.headers()['content-security-policy']).toContain("'nonce-");
    await incrementCounter(page);
    await Promise.all([
      page.waitForResponse(
        response => response.headers()['content-type']?.includes('text/x-component') === true
      ),
      page.locator('[data-nav="route"]').click(),
    ]);
    await page.waitForSelector(articleHeading, { visible: true });
  }
);

checkedBrowserTest(
  'hash navigation preserves hydrated state without fetching an RSC payload',
  async ({ checkedPage: page }) => {
    await page.goto(productionUrl('/article'));
    await page.locator(initialCount).click();
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.locator('[data-nav="hash"]').click();
    await expect.poll(() => page.url()).toMatch(/#details$/);
    await page.waitForSelector(incrementedCount, { visible: true });
    const beforeMissingAnchor = await page.evaluate(() => window.scrollY);
    expect(beforeMissingAnchor).toBeGreaterThan(0);
    await page.evaluate(
      () =>
        new Promise<void>(resolve => {
          window.addEventListener('hashchange', () => resolve(), { once: true });
          location.hash = '#missing-anchor';
        })
    );
    await expect.poll(() => page.url()).toMatch(/#missing-anchor$/);
    expect(await page.evaluate(() => window.scrollY)).toBe(beforeMissingAnchor);
    expect(requests.filter(url => /[?&]__rsc|[?&]_rsc|\.rsc(?:\?|$)/.test(url))).toEqual([]);
  }
);

checkedBrowserTest(
  'locale links remember an early selection and retain query and fragment',
  async ({ checkedPage: page }) => {
    const app = startProgrammaticApp({
      E2E_REMEMBER_LOCALE: '1',
      ISR_CACHE_NAMESPACE: `locale-preference-${Date.now()}`,
    });
    try {
      const origin = await app.ready;
      await page.evaluateOnNewDocument(() => {
        if (
          location.pathname !== '/en/article' ||
          new URLSearchParams(location.search).get('from') !== 'share'
        )
          return;
        const observer = new MutationObserver(() => {
          const link = document.querySelector<HTMLAnchorElement>('a[data-isr-locale-link][href]');
          const count = document.querySelector('main button');
          if (!link || !count) return;
          observer.disconnect();
          Reflect.set(window, 'earlyLocaleClick', count.hasAttribute('disabled'));
          link.click();
        });
        observer.observe(document, { childList: true, subtree: true, attributes: true });
      });
      const [switched] = await Promise.all([
        page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/zh-CN/article_.rsc' && url.search === '?from=share&tag=a%2Fb';
        }),
        page.goto(`${origin}/en/article?from=share&tag=a%2Fb#details`),
      ]);
      expect(switched.status()).toBe(200);
      const cookie = switched.request().headers().cookie;
      expect(cookie).toContain('isr_locale=zh-CN');
      await expect
        .poll(() => page.url())
        .toBe(`${origin}/zh-CN/article?from=share&tag=a%2Fb#details`);
      expect(await page.evaluate(() => Reflect.get(window, 'earlyLocaleClick'))).toBe(true);
      await expect.poll(() => page.$eval('html', html => html.lang)).toBe('zh-CN');
      await expect
        .poll(() =>
          page.$eval('#details', element => Math.abs(element.getBoundingClientRect().top))
        )
        .toBeLessThan(1);

      await page.goto(`${origin}/en/article`);
      expect(page.url()).toBe(`${origin}/en/article`);
      expect(await page.$eval('html', html => html.lang)).toBe('en');
      for (const path of ['/en/cached', '/en/cached_.rsc']) {
        const first = await fetch(origin + path, { headers: { cookie } });
        await first.text();
        expect(first.headers.get('x-cache-status')).toBe('MISS');
        const cached = await fetch(origin + path, { headers: { cookie } });
        await cached.text();
        expect(cached.headers.get('x-cache-status')).toBe('HIT');
        expect(cached.headers.get('content-language')).toBe('en');
      }

      const root = await fetch(`${origin}/?from=return`, {
        headers: { 'accept-language': 'en', cookie },
        redirect: 'manual',
      });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('/zh-CN?from=return');
      expect(root.headers.get('cache-control')).toMatch(/\bno-store\b/);
      await page.goto(`${origin}/?from=return`);
      expect(page.url()).toBe(`${origin}/zh-CN?from=return`);
      expect(await page.$eval('html', html => html.lang)).toBe('zh-CN');
      await page.goto('about:blank');
      app.child.send('shutdown');
      expect(await app.exited, app.output).toEqual({ code: 0, signal: null });
    } finally {
      app.kill();
    }
  }
);

for (const legacy of [false, true]) {
  checkedBrowserTest(
    'RSC commits position anchors and restore distinct history entries (' +
      (legacy ? 'classic' : 'Navigation API') +
      ')',
    async ({ checkedPage: page }) => {
      if (legacy) {
        await page.evaluateOnNewDocument(() =>
          Object.defineProperty(window, 'navigation', { value: undefined })
        );
      }
      await page.goto(productionUrl('/'));
      await waitForHydratedCounter(page);
      const scrollY = () => page.evaluate(() => window.scrollY);
      await page.evaluate(() => window.scrollTo(0, 320));
      await page.$eval('a[data-nav="route"]', link => link.click());
      await page.waitForSelector(articleHeading, { visible: true });
      await expect.poll(scrollY).toBe(0);

      await page.evaluate(() => window.scrollTo(0, 440));
      await page.evaluate(() => history.pushState({ selection: 'home' }, '', '/'));
      await page.waitForSelector(homeHeading, { visible: true });
      await expect.poll(scrollY).toBe(0);
      await page.evaluate(() => window.scrollTo(0, 210));
      await page.evaluate(() => history.pushState(null, '', '/article?section=1#details'));
      await page.waitForSelector(articleHeading, { visible: true });
      await expect
        .poll(() =>
          page.$eval('#details', element => Math.abs(element.getBoundingClientRect().top))
        )
        .toBeLessThan(1);

      await page.goBack();
      await page.waitForSelector(homeHeading, { visible: true });
      await expect.poll(scrollY).toBe(210);
      expect(await page.evaluate(() => history.state.selection)).toBe('home');
      await page.goBack();
      await page.waitForSelector(articleHeading, { visible: true });
      await expect.poll(scrollY).toBe(440);
      await page.goBack();
      await page.waitForSelector(homeHeading, { visible: true });
      await expect.poll(scrollY).toBe(320);
      await page.goForward();
      await page.waitForSelector(articleHeading, { visible: true });
      await expect.poll(scrollY).toBe(440);
    }
  );
}

test('language negotiation returns 406 when every locale is rejected', async () => {
  const headers = { 'accept-language': '*;q=0' };
  const unacceptable = await fetch(productionUrl('/article'), { headers });
  expect(unacceptable.status).toBe(406);
  expect(unacceptable.headers.get('vary')).toMatch(/Accept-Language/i);
  expect(unacceptable.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(productionUrl('/en/article'), { headers })).status).toBe(200);
});

for (const [locale, title] of [
  ['en', 'Page not found'],
  ['zh-CN', '页面未找到'],
]) {
  test(`localized missing routes return 404 and use the fallback module's SEO (${locale})`, async () => {
    const response = await fetch(productionUrl(`/${locale}/nonexistent`));
    const html = await response.text();
    expect(html).toContain(`<h1>${title}</h1>`);
    expect.soft(response.status).toBe(404);
    expect.soft(html).toContain(`<title data-isr-seo>${title}</title>`);
    expect.soft(html).toContain('name="robots" content="noindex, nofollow"');
    expect.soft(html).not.toContain('rel="canonical"');

    const flight = await fetch(productionUrl(`/${locale}/nonexistent_.rsc`));
    expect.soft(flight.status).toBe(404);
    expect(flight.headers.get('content-type')).toContain('text/x-component');
    expect.soft(await flight.text()).toContain(title);

    const matched = await fetch(productionUrl(`/${locale}/article`));
    expect(matched.status).toBe(200);
    const matchedHtml = await matched.text();
    expect(matchedHtml).toContain('<h1>Article</h1>');
    expect(matchedHtml).not.toContain('name="robots" content="noindex, nofollow"');
  });
}

browserTest(
  'client navigation clears canonical on a 404 and restores it on a regular page',
  async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error =>
      errors.push(error instanceof Error ? error.message : String(error))
    );
    const response = await page.goto(productionUrl('/en/nonexistent'));
    expect(response?.status()).toBe(404);
    await waitForHydratedCounter(page);
    await expect.poll(() => page.title()).toBe('Page not found');
    const canonical = 'head link[rel="canonical"]';
    const robots = 'meta[name="robots"]';
    const canonicalCount = () => page.$$eval(canonical, links => links.length);
    expect.soft(await canonicalCount()).toBe(0);

    const [toArticle] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/article_.rsc'),
      page.evaluate(() => history.pushState(null, '', '/article')),
    ]);
    expect(toArticle.status()).toBe(200);
    await page.waitForSelector(articleHeading, { visible: true });
    await expect.poll(() => page.title()).toBe('Production regression app');
    await expect.poll(() => page.$$eval(robots, tags => tags.length)).toBe(0);
    await expect.poll(() => page.$eval(canonical, link => link.href)).toMatch(/\/article$/);

    const [toMissing] = await Promise.all([
      page.waitForResponse(
        response => new URL(response.url()).pathname === '/zh-CN/nonexistent_.rsc'
      ),
      page.evaluate(() => history.pushState(null, '', '/zh-CN/nonexistent')),
    ]);
    expect(toMissing.status()).toBe(404);
    await page.waitForSelector('::-p-aria([name="页面未找到"][role="heading"])', { visible: true });
    await expect.poll(() => page.title()).toBe('页面未找到');
    await expect.poll(() => page.$eval(robots, tag => tag.content)).toBe('noindex, nofollow');
    await expect.poll(canonicalCount).toBe(0);
    expect(errors).toEqual([]);
  }
);

test('missing assets and malformed image input leave the production service healthy', async () => {
  const missing = await fetch(productionUrl('/assets/does-not-exist.js'));
  expect(missing.status).toBe(404);
  expect(missing.headers.get('content-type') ?? '').not.toContain('text/html');
  const image = await fetch(productionUrl('/_/img?src=%E0%A4%A&w=10'));
  expect(image.status).toBeGreaterThanOrEqual(400);
  expect(image.status).toBeLessThan(600);
  const health = await fetch(productionUrl('/health'));
  expect(health.status).toBe(200);
  expect((await health.json()).status).toBe('healthy');
  expect((await fetch(productionUrl('/article'))).status).toBe(200);
});

test('production CLI exits successfully after SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url)),
      'start',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: {
        ...process.env,
        ISR_CACHE_NAMESPACE: `${process.env.ISR_CACHE_NAMESPACE ?? 'production-browser'}:signal:${port}`,
      },
      stdio: 'pipe',
    }
  );
  let output = '';
  child.stdout.on('data', chunk => {
    output += String(chunk);
  });
  child.stderr.on('data', chunk => {
    output += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    await expect
      .poll(
        async () => {
          const health = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          await health.body?.cancel();
          return health.status;
        },
        { timeout: 15_000 }
      )
      .toBe(200);
    if (process.env.E2E_REDIS_URL) {
      const cached = await fetch(`http://127.0.0.1:${port}/cached`);
      await cached.text();
      const hit = await fetch(`http://127.0.0.1:${port}/cached`);
      await hit.text();
      expect(hit.headers.get('x-cache-status')).toBe('HIT');
      expect(output).toContain('ISR cache backend: Redis revision-validated response protocol');
    }
    child.kill('SIGTERM');
    expect(await exited, output).toEqual({ code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

checkedBrowserTest(
  'custom HTML executes under parser-derived CSP and the manifest stays outside static hosting',
  async ({ checkedPage: page }) => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('./dist/static-csp-manifest.json', import.meta.url), 'utf8')
    ) as {
      schemaVersion: number;
      buildId: string;
      files: Array<{ path: string; scriptHashes: string[] }>;
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.map(file => file.path)).toEqual([
      'parser.html',
      'regenerated/index.html',
      'static/index.html',
    ]);
    const parserEntry = manifest.files.find(file => file.path === 'parser.html');
    expect(parserEntry?.scriptHashes).toHaveLength(1);
    const response = await page.goto(productionUrl('/parser.html?mode=custom'));
    expect(response?.headers()['content-security-policy']).toContain(parserEntry!.scriptHashes[0]);
    await incrementCounter(page);
    expect(
      await page.evaluate(() =>
        ['commentExecuted', 'attributeExecuted', 'templateExecuted'].some(key =>
          Reflect.get(window, key)
        )
      )
    ).toBe(false);
    const hidden = await fetch(productionUrl('/static-csp-manifest.json'));
    expect(hidden.headers.get('content-type') ?? '').not.toContain('application/json');
  }
);

test('production startup rejects a corrupt manifest before loading application code', async () => {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const root = await fs.mkdtemp('/tmp/isr-csp-startup-');
  try {
    await fs.mkdir(`${root}/dist/client`, { recursive: true });
    await fs.mkdir(`${root}/dist/rsc`);
    await fs.writeFile(`${root}/dist/rsc/index.js`, 'throw new Error("Application must not load")');
    await fs.writeFile(`${root}/dist/static-csp-manifest.json`, '{"schemaVersion":999}');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url)), 'start'],
      { cwd: root, stdio: 'pipe' }
    );
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr.on('data', chunk => {
      output += String(chunk);
    });
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>(resolve =>
        child.once('exit', (code, signal) => resolve({ code, signal }))
      );
      expect(result).toEqual({ code: 1, signal: null });
      expect(output).toContain('Unsupported static CSP manifest schema');
      expect(output).not.toContain('Application must not load');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

browserTest(
  'cached ISR HTML refreshes every script attribute and JavaScript nonce reference on HIT',
  async ({ browser }) => {
    const seen: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      // A reload explicitly requests revalidation. Independent contexts exercise
      // shared-cache HITs without a browser cache or a forced-refresh directive.
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        const errors = collectBrowserErrors(page);
        const response = await page.goto(productionUrl('/cached'));
        expect(response?.headers()['x-cache-status']).toBe(attempt === 0 ? 'MISS' : 'HIT');
        const nonce = response?.headers()['content-security-policy'].match(/'nonce-([^']+)'/)?.[1];
        expect(nonce).toMatch(/^[a-f0-9]{32}$/);
        expect(seen).not.toContain(nonce);
        const scripts = await page.$$eval('script', elements =>
          elements.map(script => ({ nonce: script.nonce, text: script.textContent ?? '' }))
        );
        expect(scripts.length).toBeGreaterThan(0);
        expect(scripts.every(script => script.nonce === nonce)).toBe(true);
        expect(
          scripts.some(script => script.text.includes(`window.__nonceReference="${nonce}"`))
        ).toBe(true);
        expect(await page.evaluate(() => Reflect.get(window, '__nonceReference'))).toBe(nonce);
        const html = await response!.text();
        for (const previous of seen) expect(html).not.toContain(previous);
        await incrementCounter(page);
        expect(errors).toEqual([]);
        seen.push(nonce!);
      } finally {
        await context.close();
      }
    }
  }
);

checkedBrowserTest(
  'browser reload requests origin freshness instead of replaying cached ISR HTML',
  async ({ checkedPage: page }) => {
    const first = await page.goto(productionUrl('/cached?browser-refresh=1'));
    expect(first?.headers()['x-cache-status']).toBe('MISS');
    const refreshed = await page.reload();
    const headers = refreshed!.request().headers();
    expect(headers['cache-control']).toMatch(/no-cache|max-age=0/);
    expect(refreshed?.headers()['x-cache-status']).toBe('BYPASS');
    await incrementCounter(page);
  }
);

checkedBrowserTest(
  'dynamic .html application routes render and hydrate without a static manifest entry',
  async ({ checkedPage: page }) => {
    const response = await page.goto(productionUrl('/articles/dynamic.html'));
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-served-by']).toBeUndefined();
    expect(response?.headers()['content-security-policy']).toContain("'nonce-");
    await page.waitForSelector(homeHeading, { visible: true });
    await incrementCounter(page);
  }
);

checkedBrowserTest(
  'published programmatic app renders, hydrates, invalidates ISR and shuts down naturally',
  async ({ checkedPage: page }) => {
    const fs = await import('node:fs/promises');
    const source = new URL('./ssg-source.txt', import.meta.url);
    const app = startProgrammaticApp({ ISR_CACHE_NAMESPACE: `programmatic-${Date.now()}` });
    const { child } = app;
    try {
      const url = await app.ready;
      const response = await page.goto(`${url}/static?search=a.b`);
      expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
      await incrementCounter(page);
      await page.locator('[data-nav="route"]').click();
      await page.waitForSelector(articleHeading, { visible: true });
      expect(await cacheStatus(`${url}/cached`)).toBe('MISS');
      expect(await cacheStatus(`${url}/cached`)).toBe('HIT');
      const invalidated = new Promise<void>(resolve => child.once('message', () => resolve()));
      child.send('invalidate');
      await invalidated;
      expect(await cacheStatus(`${url}/cached`)).toBe('MISS');
      await fs.writeFile(source, 'programmatic-ssg-before');
      await (await fetch(`${url}/regenerated`)).text();
      await fs.writeFile(source, 'programmatic-ssg-after');
      const ssgInvalidated = new Promise<void>(resolve => child.once('message', () => resolve()));
      child.send('invalidate-ssg');
      await ssgInvalidated;
      const fresh = await fetch(`${url}/regenerated/`);
      expect(fresh.url).toBe(`${url}/regenerated`);
      expect(fresh.headers.get('x-cache-status')).toBe('MISS');
      expect(await fresh.text()).toContain('programmatic-ssg-after');
      for (const alias of ['/regenerated/', '/regenerated/index.html']) {
        const response = await page.goto(`${url}${alias}`);
        expect(page.url()).toBe(`${url}/regenerated`);
        expect(response?.headers()['x-cache-key']).toBe(fresh.headers.get('x-cache-key'));
        expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
        expect(response?.headers()['content-security-policy']).toContain("'nonce-");
        await expect
          .poll(() => page.$eval('[data-ssg-source]', element => element.textContent))
          .toBe('programmatic-ssg-after');
        await incrementCounter(page);
      }
      expect((await fetch(`${url}/health`)).headers.get('content-type')).toContain('text/html');
      const restarted = new Promise<string>(resolve =>
        child.once('message', message => resolve((message as { ready: string }).ready))
      );
      await page.goto('about:blank');
      child.send('restart');
      const restartedUrl = await restarted;
      expect((await fetch(`${restartedUrl}/health`)).headers.get('content-type')).toContain(
        'text/html'
      );
      // Redis responses survive runtime shutdown; the in-process store is recreated.
      expect(await cacheStatus(`${restartedUrl}/cached`)).toBe(
        process.env.E2E_REDIS_URL ? 'HIT' : 'MISS'
      );
      const invalidatedAfterRestart = new Promise<void>(resolve =>
        child.once('message', () => resolve())
      );
      child.send('invalidate');
      await invalidatedAfterRestart;
      expect(await cacheStatus(`${restartedUrl}/cached`)).toBe('MISS');
      expect(await cacheStatus(`${restartedUrl}/cached`)).toBe('HIT');
      await page.goto(`${restartedUrl}/article`);
      await incrementCounter(page);
      await page.goto('about:blank');
      child.send('shutdown');
      expect(await app.exited, app.output).toEqual({ code: 0, signal: null });
      await expect(fetch(`${url}/health`)).rejects.toThrow();
    } finally {
      await fs.rm(source, { force: true });
      app.kill();
    }
  }
);

checkedBrowserTest(
  'SSG regenerates changed source after TTL with coherent hydration and CSP',
  async ({ checkedPage: page }) => {
    const fs = await import('node:fs/promises');
    const source = new URL('./ssg-source.txt', import.meta.url);
    const manifest = new URL('./dist/static-csp-manifest.json', import.meta.url);
    const immutable = await fs.readFile(manifest, 'utf8');
    try {
      await fs.writeFile(source, 'runtime-source-one');
      await page.goto(productionUrl('/regenerated'));
      const regeneratedHtml = async () => (await fetch(productionUrl('/regenerated'))).text();
      await expect.poll(regeneratedHtml, { timeout: 15_000 }).toContain('runtime-source-one');
      await fs.writeFile(source, 'runtime-source-two');
      await expect.poll(regeneratedHtml, { timeout: 15_000 }).toContain('runtime-source-two');
      const response = await page.goto(productionUrl('/regenerated'));
      const canonicalCacheKey = response?.headers()['x-cache-key'];
      expect(canonicalCacheKey).toBeTruthy();
      expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
      expect(response?.headers()['content-security-policy']).toContain("'nonce-");
      await expect
        .poll(() => page.$eval('[data-ssg-source]', element => element.textContent))
        .toBe('runtime-source-two');
      await incrementCounter(page);
      for (const alias of ['/regenerated/', '/regenerated/index.html']) {
        const redirect = await fetch(productionUrl(`${alias}?keep=a%2Fb`), { redirect: 'manual' });
        expect(redirect.status).toBe(308);
        expect(redirect.headers.get('location')).toBe('/regenerated?keep=a%2Fb');
        const response = await page.goto(productionUrl(alias));
        expect(page.url()).toMatch(/\/regenerated$/);
        expect(response?.headers()['x-cache-key']).toBe(canonicalCacheKey);
        expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
        expect(response?.headers()['content-security-policy']).toContain("'nonce-");
        await expect
          .poll(() => page.$eval('[data-ssg-source]', element => element.textContent))
          .toBe('runtime-source-two');
        await incrementCounter(page);
      }
      const rscAlias = await fetch(productionUrl('/regenerated/_.rsc'));
      expect(rscAlias.url).toMatch(/\/regenerated_\.rsc$/);
      expect(rscAlias.headers.get('content-type')).toContain('text/x-component');
      expect(await rscAlias.text()).toContain('runtime-source-two');
      expect(await fs.readFile(manifest, 'utf8')).toBe(immutable);
    } finally {
      await fs.rm(source, { force: true });
    }
  }
);
