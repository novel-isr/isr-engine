import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createIsrPlugin } from 'isr-engine';

test(
  'development HEAD skips rendering and a disconnected Flight request cancels quietly',
  { timeout: 60_000 },
  async t => {
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
    const errors = [];
    t.after(async () => {
      console.error = originalError;
      await vite.close();
    });
    await vite.listen(0);
    const server = vite.httpServer;
    const origin = `http://127.0.0.1:${server.address().port}`;
    console.error = (...args) => {
      errors.push(args.map(String).join(' '));
    };

    for (const [path, contentType] of [
      ['/article', 'text/html'],
      ['/article_.rsc', 'text/x-component'],
    ]) {
      const head = await fetch(origin + path + '?mode=isr&render-error=1', {
        method: 'HEAD',
        signal: t.signal,
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('x-resolved-mode'), 'isr');
      assert.ok(head.headers.get('content-type')?.includes(contentType));
      assert.equal(await head.text(), '');
    }

    const disconnected = new Promise(resolve => {
      server.prependOnceListener('request', (_req, res) => res.once('close', resolve));
    });
    const controller = new AbortController();
    const response = await fetch(origin + '/article_.rsc?mode=isr&delay=2000', {
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache-status'), 'MISS');
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await reader.closed.catch(() => undefined);
    await disconnected;
    const retry = await fetch(origin + '/article_.rsc?mode=isr&delay=2000', { signal: t.signal });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-cache-status'), 'MISS');
    await retry.text();
    assert.deepEqual(errors, []);

    const failed = await fetch(origin + '/article_.rsc?render-error=1', { signal: t.signal });
    assert.match(await failed.text(), /development render failure/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /development render failure/);
  }
);
