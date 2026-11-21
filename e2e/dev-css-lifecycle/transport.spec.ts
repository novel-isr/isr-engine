import { expect, test } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createIsrPlugin } from 'isr-engine';

test('development HEAD skips rendering and a disconnected Flight request cancels quietly', async () => {
  const { createServer } = await import('vite');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const vite = await createServer({
    root,
    configFile: false,
    cacheDir: fileURLToPath(new URL('./node_modules/.vite-transport', import.meta.url)),
    plugins: createIsrPlugin({ root }),
    server: { host: '127.0.0.1', hmr: false },
  });
  const originalError = console.error;
  const errors: string[] = [];
  try {
    await vite.listen(0);
    const server = vite.httpServer!;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    for (const [path, contentType] of [
      ['/article', 'text/html'],
      ['/article_.rsc', 'text/x-component'],
    ]) {
      const head = await fetch(origin + path + '?render-error=1', { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toContain(contentType);
      expect(await head.text()).toBe('');
    }

    const disconnected = new Promise<void>(resolve => {
      server.prependOnceListener('request', (_req, res) => res.once('close', resolve));
    });
    const controller = new AbortController();
    const response = await fetch(origin + '/article_.rsc?delay=2000', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await reader.closed.catch(() => undefined);
    await disconnected;
    expect(errors).toEqual([]);

    const failed = await fetch(origin + '/article_.rsc?render-error=1');
    expect(await failed.text()).toContain('development render failure');
    expect(errors).toEqual([expect.stringContaining('development render failure')]);
  } finally {
    console.error = originalError;
    await vite.close();
  }
});
