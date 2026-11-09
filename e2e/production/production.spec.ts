import { expect, test } from '@playwright/test';
import express from 'express';
import { createCspNonceMiddleware, createSecurityMiddleware } from '../../src/server/middleware';

const browserErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  browserErrors.length = 0;
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('data and Blob images load under both development and production image policies', async ({
  page,
}) => {
  for (const isDev of [true, false]) {
    const app = express();
    app.use(createCspNonceMiddleware(), createSecurityMiddleware(isDev));
    app.get('/favicon.ico', (_req, res) => {
      res.status(204).end();
    });
    app.get('/', (_req, res) => {
      res
        .type('html')
        .send('<!doctype html><html><head><title>Image policy</title></head><body></body></html>');
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
      await page.goto(`http://127.0.0.1:${address.port}/`);
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
});

test('SSG with a query hydrates under its CSP and supports RSC navigation', async ({ page }) => {
  const response = await page.goto('/static?search=a.b');
  expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
  expect(response?.headers()['content-security-policy']).toContain("'nonce-");
  await page.getByRole('button', { name: 'Count 0' }).click();
  await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
  const navigation = page.waitForResponse(
    response => response.headers()['content-type']?.includes('text/x-component') === true
  );
  await page.locator('[data-nav="route"]').click();
  await navigation;
  await expect(page.getByRole('heading', { name: 'Article' })).toBeVisible();
});

test('hash navigation preserves hydrated state without fetching an RSC payload', async ({
  page,
}) => {
  await page.goto('/article');
  await page.getByRole('button', { name: 'Count 0' }).click();
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.locator('[data-nav="hash"]').click();
  await expect(page).toHaveURL(/#details$/);
  await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
  expect(requests.filter(url => /[?&]__rsc|[?&]_rsc|\.rsc(?:\?|$)/.test(url))).toEqual([]);
});

test('missing assets and malformed image input leave the production service healthy', async ({
  request,
}) => {
  const missing = await request.get('/assets/does-not-exist.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type'] ?? '').not.toContain('text/html');
  const image = await request.get('/_/img?src=%E0%A4%A&w=10');
  expect(image.status()).toBeGreaterThanOrEqual(400);
  expect(image.status()).toBeLessThan(600);
  const health = await request.get('/health');
  expect(health.status()).toBe(200);
  expect((await health.json()).status).toBe('healthy');
  expect((await request.get('/article')).status()).toBe(200);
});

test('production CLI exits successfully after SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
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
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    if (process.env.PLAYWRIGHT_REDIS_URL) {
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

test('custom HTML executes under parser-derived CSP and the manifest stays outside static hosting', async ({
  page,
  request,
}) => {
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
  const response = await page.goto('/parser.html?mode=custom');
  expect(response?.headers()['content-security-policy']).toContain(parserEntry!.scriptHashes[0]);
  await page.getByRole('button', { name: 'Count 0' }).click();
  await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      ['commentExecuted', 'attributeExecuted', 'templateExecuted'].some(key =>
        Reflect.get(window, key)
      )
    )
  ).toBe(false);
  const hidden = await request.get('/static-csp-manifest.json');
  expect(hidden.headers()['content-type'] ?? '').not.toContain('application/json');
});

test('production startup rejects a corrupt manifest before loading application code', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
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

test('cached ISR HTML refreshes every script attribute and JavaScript nonce reference on HIT', async ({
  page,
}) => {
  const seen: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = attempt === 0 ? await page.goto('/cached') : await page.reload();
    expect(response?.headers()['x-cache-status']).toBe(attempt === 0 ? 'MISS' : 'HIT');
    const nonce = response?.headers()['content-security-policy'].match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(seen).not.toContain(nonce);
    const scripts = await page
      .locator('script')
      .evaluateAll(elements =>
        elements.map(script => ({ nonce: script.nonce, text: script.textContent ?? '' }))
      );
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every(script => script.nonce === nonce)).toBe(true);
    expect(scripts.some(script => script.text.includes(`window.__nonceReference="${nonce}"`))).toBe(
      true
    );
    expect(await page.evaluate(() => Reflect.get(window, '__nonceReference'))).toBe(nonce);
    const html = await response!.text();
    for (const previous of seen) expect(html).not.toContain(previous);
    await page.getByRole('button', { name: 'Count 0' }).click();
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    seen.push(nonce!);
  }
});

test('dynamic .html application routes render and hydrate without a static manifest entry', async ({
  page,
}) => {
  const response = await page.goto('/articles/dynamic.html');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['x-served-by']).toBeUndefined();
  expect(response?.headers()['content-security-policy']).toContain("'nonce-");
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByRole('button', { name: 'Count 0' }).click();
  await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
});

test('published programmatic app renders, hydrates, invalidates ISR and shuts down naturally', async ({
  page,
  request,
}) => {
  const { fork } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const source = new URL('./ssg-source.txt', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const child = fork(fileURLToPath(new URL('./programmatic-server.mjs', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, ISR_CACHE_NAMESPACE: `programmatic-${Date.now()}` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', chunk => (output += String(chunk)));
  child.stderr!.on('data', chunk => (output += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.once('message', message => resolve((message as { ready: string }).ready));
      child.once('exit', code =>
        reject(new Error(`Programmatic startup exited ${code}: ${output}`))
      );
    });
    const response = await page.goto(`${url}/static?search=a.b`);
    expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
    await page.getByRole('button', { name: 'Count 0' }).click();
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    await page.locator('[data-nav="route"]').click();
    await expect(page.getByRole('heading', { name: 'Article' })).toBeVisible();
    const first = await request.get(`${url}/cached`);
    expect(first.headers()['x-cache-status']).toBe('MISS');
    expect((await request.get(`${url}/cached`)).headers()['x-cache-status']).toBe('HIT');
    const invalidated = new Promise<void>(resolve => child.once('message', () => resolve()));
    child.send('invalidate');
    await invalidated;
    expect((await request.get(`${url}/cached`)).headers()['x-cache-status']).toBe('MISS');
    await fs.writeFile(source, 'programmatic-ssg-before');
    await request.get(`${url}/regenerated`);
    await fs.writeFile(source, 'programmatic-ssg-after');
    const ssgInvalidated = new Promise<void>(resolve => child.once('message', () => resolve()));
    child.send('invalidate-ssg');
    await ssgInvalidated;
    const fresh = await request.get(`${url}/regenerated/`);
    expect(fresh.url()).toBe(`${url}/regenerated`);
    expect(fresh.headers()['x-cache-status']).toBe('MISS');
    expect(await fresh.text()).toContain('programmatic-ssg-after');
    for (const alias of ['/regenerated/', '/regenerated/index.html']) {
      const response = await page.goto(`${url}${alias}`);
      await expect(page).toHaveURL(`${url}/regenerated`);
      expect(response?.headers()['x-cache-key']).toBe(fresh.headers()['x-cache-key']);
      expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
      expect(response?.headers()['content-security-policy']).toContain("'nonce-");
      await expect(page.locator('[data-ssg-source]')).toHaveText('programmatic-ssg-after');
      await page.getByRole('button', { name: 'Count 0' }).click();
      await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    }
    expect((await request.get(`${url}/health`)).headers()['content-type']).toContain('text/html');
    const restarted = new Promise<string>(resolve =>
      child.once('message', message => resolve((message as { ready: string }).ready))
    );
    child.send('restart');
    const restartedUrl = await restarted;
    expect((await request.get(`${restartedUrl}/health`)).headers()['content-type']).toContain(
      'text/html'
    );
    // Redis responses survive runtime shutdown; the in-process store is recreated.
    expect((await request.get(`${restartedUrl}/cached`)).headers()['x-cache-status']).toBe(
      process.env.PLAYWRIGHT_REDIS_URL ? 'HIT' : 'MISS'
    );
    const invalidatedAfterRestart = new Promise<void>(resolve =>
      child.once('message', () => resolve())
    );
    child.send('invalidate');
    await invalidatedAfterRestart;
    expect((await request.get(`${restartedUrl}/cached`)).headers()['x-cache-status']).toBe('MISS');
    expect((await request.get(`${restartedUrl}/cached`)).headers()['x-cache-status']).toBe('HIT');
    await page.goto(`${restartedUrl}/article`);
    await page.getByRole('button', { name: 'Count 0' }).click();
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    child.send('shutdown');
    expect(await exited, output).toEqual({ code: 0, signal: null });
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  } finally {
    await fs.rm(source, { force: true });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('SSG regenerates changed source after TTL with coherent hydration and CSP', async ({
  page,
  request,
}) => {
  const fs = await import('node:fs/promises');
  const source = new URL('./ssg-source.txt', import.meta.url);
  const manifest = new URL('./dist/static-csp-manifest.json', import.meta.url);
  const immutable = await fs.readFile(manifest, 'utf8');
  try {
    await fs.writeFile(source, 'runtime-source-one');
    await page.goto('/regenerated');
    await expect
      .poll(async () => {
        const response = await request.get('/regenerated');
        return response.text();
      })
      .toContain('runtime-source-one');
    await fs.writeFile(source, 'runtime-source-two');
    await expect
      .poll(async () => {
        const response = await request.get('/regenerated');
        return response.text();
      })
      .toContain('runtime-source-two');
    const response = await page.goto('/regenerated');
    const canonicalCacheKey = response?.headers()['x-cache-key'];
    expect(canonicalCacheKey).toBeTruthy();
    expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
    expect(response?.headers()['content-security-policy']).toContain("'nonce-");
    await expect(page.locator('[data-ssg-source]')).toHaveText('runtime-source-two');
    await page.getByRole('button', { name: 'Count 0' }).click();
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    for (const alias of ['/regenerated/', '/regenerated/index.html']) {
      const redirect = await request.get(`${alias}?keep=a%2Fb`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(308);
      expect(redirect.headers()['location']).toBe('/regenerated?keep=a%2Fb');
      const response = await page.goto(alias);
      await expect(page).toHaveURL(/\/regenerated$/);
      expect(response?.headers()['x-cache-key']).toBe(canonicalCacheKey);
      expect(response?.headers()['x-served-by']).toBe('ssg-runtime');
      expect(response?.headers()['content-security-policy']).toContain("'nonce-");
      await expect(page.locator('[data-ssg-source]')).toHaveText('runtime-source-two');
      await page.getByRole('button', { name: 'Count 0' }).click();
      await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    }
    const rscAlias = await request.get('/regenerated/_.rsc');
    expect(rscAlias.url()).toMatch(/\/regenerated_\.rsc$/);
    expect(rscAlias.headers()['content-type']).toContain('text/x-component');
    expect(await rscAlias.text()).toContain('runtime-source-two');
    expect(await fs.readFile(manifest, 'utf8')).toBe(immutable);
  } finally {
    await fs.rm(source, { force: true });
  }
});
