import { afterEach, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import sharp from 'sharp';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImagePlugin } from '../createImagePlugin';
let server: ViteDevServer | undefined;
let dir: string;
afterEach(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('optimizes real Vite public and imported asset URLs while enforcing filesystem policy', async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'image-vite-')));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'public'), { recursive: true });
  await mkdir(path.join(root, 'src'));
  const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  for (const name of [
    'public/cover.png',
    'public/a b.png',
    'public/a#b?.png',
    'src/imported.png',
    '.env.png',
  ])
    await writeFile(path.join(root, name), image);
  await writeFile(path.join(dir, 'outside.png'), image);
  await mkdir(path.join(dir, 'shared'));
  await writeFile(path.join(dir, 'shared/allowed.png'), image);
  await symlink(path.join(dir, 'outside.png'), path.join(root, 'src/link.png'));
  await writeFile(
    path.join(root, 'src/main.js'),
    'import image from "@images/imported.png"; export default image; export { default as shared } from "@shared/allowed.png"'
  );
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { alias: { '@images': path.join(root, 'src'), '@shared': path.join(dir, 'shared') } },
    plugins: [createImagePlugin()],
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [root, path.join(dir, 'shared')], deny: ['**/.env*'] },
    },
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const optimize = (src: string, extra = '') =>
    fetch(`${base}/_/img?src=${encodeURIComponent(src)}&fmt=png${extra}`);
  const transformed = (await server.transformRequest('/src/main.js'))!.code;
  expect(transformed).toContain('/src/imported.png');
  const sharedUrl = `/@fs${path.join(dir, 'shared/allowed.png')}`;
  expect(transformed).toContain(sharedUrl);
  for (const src of [
    '/cover.png?v=1',
    '/cover.png#hero',
    '/a%20b.png',
    '/src/imported.png?import',
    sharedUrl,
  ]) {
    expect((await fetch(`${base}${src}`)).status, src).toBe(200);
    const response = await optimize(src);
    expect(response.status, src).toBe(200);
    expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
      width: 40,
      height: 20,
    });
  }
  expect((await optimize('/a%23b%3F.png')).status).toBe(200);
  for (const src of [
    '/%2e%2e/outside.png',
    '/%2e%2e%2foutside.png',
    '/%00.png',
    '/bad%ZZ.png',
    '/src%5c..%5c.env.png',
    '/src/link.png',
    '/.env.png',
    `/@fs${path.join(dir, 'outside.png')}`,
  ])
    expect((await optimize(src)).status, src).not.toBe(200);
});
it('applies EXIF orientation before resizing displayed dimensions', async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'image-orientation-')));
  await mkdir(path.join(dir, 'public'));
  await writeFile(
    path.join(dir, 'public/portrait.jpg'),
    await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
  );
  server = await createServer({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    plugins: [createImagePlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const port = (server.httpServer!.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/_/img?src=/portrait.jpg&w=10&fmt=png`);
  expect(response.status).toBe(200);
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  expect(metadata).toMatchObject({ width: 10, height: 20 });
  expect(metadata.orientation).toBeUndefined();
});

it('does not expose a disabled public directory through root-relative optimizer URLs', async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'image-no-public-')));
  await mkdir(path.join(dir, 'public'));
  await writeFile(
    path.join(dir, 'public/hidden.png'),
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
  );
  server = await createServer({
    configFile: false,
    root: dir,
    publicDir: false,
    logLevel: 'silent',
    plugins: [createImagePlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const port = (server.httpServer!.address() as { port: number }).port;
  expect((await fetch(`http://127.0.0.1:${port}/_/img?src=/hidden.png&fmt=png`)).status).toBe(404);
});

it.each(['#', '?'])(
  'preserves %s in filesystem policy checks for direct and symlink sources',
  async marker => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'image-vite-policy-')));
    const root = path.join(dir, 'app');
    const outside = `${root}${marker}private`;
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(outside);
    const image = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await writeFile(path.join(outside, 'secret.png'), image);
    await writeFile(path.join(root, 'src', `allowed${marker}asset.png`), image);
    await symlink(path.join(outside, 'secret.png'), path.join(root, 'src/link.png'));
    server = await createServer({
      configFile: false,
      root,
      publicDir: false,
      logLevel: 'silent',
      plugins: [createImagePlugin()],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    });
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    const optimize = (src: string) =>
      fetch(`http://127.0.0.1:${port}/_/img?src=${encodeURIComponent(src)}&fmt=png`);
    expect((await optimize(`/src/allowed${encodeURIComponent(marker)}asset.png`)).status).toBe(200);
    const outsideUrl = `/@fs${path.join(outside, 'secret.png').replace(marker, encodeURIComponent(marker))}`;
    expect((await optimize(outsideUrl)).status).toBe(403);
    expect((await optimize('/src/link.png')).status).toBe(403);
  }
);
