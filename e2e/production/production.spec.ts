import { expect, test } from '@playwright/test';

const browserErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  browserErrors.length = 0;
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('SSG with a query hydrates under its CSP and supports RSC navigation', async ({ page }) => {
  const response = await page.goto('/static?search=a.b');
  expect(response?.headers()['x-served-by']).toBe('ssg-static');
  expect(response?.headers()['content-security-policy']).toContain("'sha256-");
  expect(response?.headers()['content-security-policy']).not.toContain('strict-dynamic');
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
    child.kill('SIGTERM');
    expect(await exited, output).toEqual({ code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
