import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-native-runtime-'));
process.env.NODE_ENV = 'production';
const { createISRApp } = await import(pathToFileURL(path.join(cwd, 'dist/novel-isr.js')).href);
let app;
try {
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    `export default { state: 'native-runtime', fetch() { return new Response(this.state); } };`
  );
  process.chdir(root);
  app = await createISRApp({
    renderMode: 'ssr',
    revalidate: 60,
    routes: {},
    ssg: { routes: [] },
    server: { host: '127.0.0.1', port: 0 },
    runtime: {
      site: 'https://example.com',
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,
      telemetry: false,
    },
  });
  const context = await app.start();
  const response = await fetch(context.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'native-runtime');
  console.log('Native production import, Fetch receiver and HTTP lifecycle verified.');
} finally {
  await app?.shutdown();
  process.chdir(cwd);
  await fs.rm(root, { recursive: true, force: true });
}
