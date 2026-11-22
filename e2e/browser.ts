import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launch, type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import { test } from 'vitest';

export const browserTest = test.extend<{ browser: Browser; page: Page }>({
  browser: [
    async ({}, use) => {
      const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
      const browser = await launch(executablePath ? { executablePath } : { channel: 'chrome' });
      try {
        await use(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: 'file' },
  ],
  page: async ({ browser }, use) => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await use(page);
    } finally {
      await context.close();
    }
  },
});

export async function interceptRequests(
  page: Page,
  handle: (request: HTTPRequest) => void | Promise<void>
): Promise<() => Promise<void>> {
  const listener = async (request: HTTPRequest) => {
    try {
      await handle(request);
    } finally {
      if (!request.isInterceptResolutionHandled()) await request.continue();
    }
  };
  page.on('request', listener);
  await page.setRequestInterception(true);
  return async () => {
    await page.setRequestInterception(false);
    page.off('request', listener);
  };
}

export async function startBrowserServer(project: 'dev-css-lifecycle' | 'production') {
  const dev = project === 'dev-css-lifecycle';
  const port = dev
    ? (process.env.E2E_DEV_PORT ?? '43137')
    : (process.env.E2E_PRODUCTION_PORT ?? '43138');
  const host = '127.0.0.1';
  const origin = `http://${host}:${port}`;
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host, port: Number(port) }, () =>
      probe.close(error => (error ? reject(error) : resolve()))
    );
  });
  const cli = fileURLToPath(new URL('../dist/cli/cli.js', import.meta.url));
  const child = spawn(
    process.execPath,
    [cli, ...(dev ? ['dev', '--no-open'] : ['start']), '--host', host, '--port', port],
    {
      cwd: new URL(`./${project}/`, import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production',
        ISR_CACHE_NAMESPACE: process.env.ISR_CACHE_NAMESPACE ?? `e2e-${randomUUID()}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  const lifetime = new AbortController();
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(-12_000);
    });
  }
  child.once('error', error => lifetime.abort(error));
  const exited = new Promise<void>(resolve => {
    child.once('close', (code, signal) => {
      lifetime.abort(new Error(`Server exited with ${code ?? signal}`));
      resolve();
    });
  });
  const close = async () => {
    if (!child.kill('SIGTERM')) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000)]);
  try {
    for (;;) {
      startup.throwIfAborted();
      const signal = AbortSignal.any([startup, AbortSignal.timeout(2_000)]);
      const response = await fetch(origin, { signal }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.ok) return { origin, close };
      await delay(100, undefined, { signal: startup });
    }
  } catch (error) {
    await close();
    throw new Error(`Could not start ${project}\n${output}`, { cause: error });
  }
}
