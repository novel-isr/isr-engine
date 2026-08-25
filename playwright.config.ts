import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const port = Number(process.env.PLAYWRIGHT_DEV_PORT ?? 43137);
const baseURL = `http://127.0.0.1:${port}`;
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (process.platform === 'darwin' && existsSync(localChrome) ? localChrome : undefined);

export default defineConfig({
  testDir: './e2e/dev-css-lifecycle',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --dir e2e/dev-css-lifecycle exec novel-isr dev --no-open --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
