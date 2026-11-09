import { it, expect } from 'vitest';
import express from 'express';
import { Writable } from 'node:stream';
import type { Response } from 'express';
import { nodeToWebRequest, pipeWebResponse, createProductionJsonMiddleware } from '../start';

it('preserves separate response cookies and existing middleware cookies', async () => {
  const app = express();
  app.get('/', async (_req, res) => {
    res.setHeader('set-cookie', 'anon=1; Path=/');
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/');
    await pipeWebResponse(new Response(null, { headers }), res);
  });
  await serve(app, async url => {
    const response = await fetch(url);
    expect(response.headers.getSetCookie()).toEqual([
      'anon=1; Path=/',
      'a=1; Path=/',
      'b=2; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/',
    ]);
  });
});

it('forwards exact JSON bytes after parsing and enforces the 1mb limit', async () => {
  const app = express();
  app.use(createProductionJsonMiddleware());
  app.post('/', async (req, res) =>
    res.json({ parsed: req.body, raw: await nodeToWebRequest(req).text() })
  );
  await serve(app, async url => {
    const raw = ' { "hello" : "世界" } ';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ parsed: { hello: '世界' }, raw });
    const large = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 'x'.repeat(1024 * 1024) }),
    });
    expect(large.status).toBe(413);
  });
});

it('cancels the upstream stream and settles when the client disconnects', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      this.destroy();
    },
  });
  const res = Object.assign(sink, {
    status() {
      return this;
    },
    setHeader() {
      return this;
    },
  }) as unknown as Response;
  await Promise.race([
    pipeWebResponse(new Response(body), res),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('adapter hung after disconnect')), 500)
    ),
  ]);
  expect(cancelled).toBe(true);
});

async function serve(app: ReturnType<typeof express>, check: (url: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    await check(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it('serves SSG query URLs from the validated index and refuses unindexed HTML', async () => {
  const { createStaticHtmlMiddleware } = await import('../start');
  const { generateStaticCspManifest, loadStaticCspManifest } =
    await import('../../security/staticCspManifest');
  const fs = await import('node:fs/promises');
  const dir = await fs.mkdtemp('/tmp/isr-ssg-');
  try {
    await fs.mkdir(`${dir}/client/page`, { recursive: true });
    await fs.mkdir(`${dir}/rsc`);
    await fs.writeFile(`${dir}/rsc/index.js`, 'export default {}');
    await fs.writeFile(
      `${dir}/client/page/index.html`,
      '<html><script>window.active=true</script>static</html>'
    );
    await generateStaticCspManifest(dir);
    const index = await loadStaticCspManifest(dir);
    await fs.writeFile(`${dir}/client/late.html`, '<script>unindexed()</script>');
    await fs.mkdir(`${dir}/client/rogue`);
    await fs.writeFile(`${dir}/client/rogue/index.html`, '<script>unindexed()</script>');
    const app = express();
    app.use(createStaticHtmlMiddleware(`${dir}/client`, index));
    app.use(express.static(`${dir}/client`, { redirect: false, index: false }));
    app.use((_req, res) => res.status(404).end());
    await serve(app, async url => {
      for (const route of ['/page?search=a.b', '/page/', '/page/index.html']) {
        const response = await fetch(url + route);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-security-policy')).toContain("'sha256-");
        expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
        expect(await response.text()).toContain('window.active=true');
      }
      expect((await fetch(url + '/late.html')).status).toBe(503);
      expect((await fetch(url + '/rogue/')).status).toBe(404);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('protects private health with the configured ops token', async () => {
  const { resolveOpsConfig, createOpsAuthMiddleware } = await import('../../server/opsConfig');
  const config = resolveOpsConfig(
    {
      server: {
        port: 3000,
        host: '127.0.0.1',
        strictPort: true,
        ops: {
          authToken: 'secret',
          tokenHeader: 'x-isr-admin-token',
          health: { enabled: true, public: false },
          metrics: { enabled: false, public: false },
          inventory: { enabled: false, public: false },
        },
      },
    },
    'production'
  );
  const app = express();
  app.get('/health', createOpsAuthMiddleware('health', config), (_req, res) =>
    res.json({ status: 'healthy' })
  );
  await serve(app, async url => {
    expect((await fetch(`${url}/health`)).status).toBe(401);
    expect(
      (await fetch(`${url}/health`, { headers: { authorization: 'Bearer wrong' } })).status
    ).toBe(403);
    expect(
      (await fetch(`${url}/health`, { headers: { authorization: 'Bearer secret' } })).status
    ).toBe(200);
  });
});
