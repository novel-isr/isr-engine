import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import vitePluginRsc from '@vitejs/plugin-rsc';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import { createDevCssHandoffPlugin } from '../createDevCssHandoffPlugin';

const fixtureRoots: string[] = [];
const viteServers: ViteDevServer[] = [];
const httpServers: http.Server[] = [];

describe('development RSC stylesheet identity', () => {
  afterEach(async () => {
    await Promise.all(viteServers.splice(0).map(server => server.close()));
    await Promise.all(
      httpServers
        .splice(0)
        .map(server => new Promise<void>(resolve => server.close(() => resolve())))
    );
    await Promise.all(
      fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    );
  });

  it('separates the SSR stylesheet URL from the JavaScript CSS-module URL', async () => {
    const root = await createFixture();
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      plugins: [
        createDevCssHandoffPlugin(path.resolve(process.cwd(), 'src/defaults')),
        ...vitePluginRsc({
          entries: {
            client: '/src/entry.browser.ts',
            rsc: '/src/entry.rsc.ts',
            ssr: '/src/entry.ssr.ts',
          },
        }),
      ],
    });
    viteServers.push(server);

    const clientReferenceId = '/src/ClientCard.tsx';
    await server.environments.rsc.transformRequest(clientReferenceId);
    await server.environments.ssr.transformRequest('/src/ClientCard.tsx');
    const virtualId = `virtual:vite-rsc/css?type=ssr&id=${encodeURIComponent(clientReferenceId)}&lang.js`;
    const resolved = await server.environments.ssr.pluginContainer.resolveId(virtualId);
    expect(resolved).toBeTruthy();

    const transformed = await server.environments.ssr.transformRequest(resolved!.id);
    expect(transformed?.code).toContain('/src/ClientCard.module.scss?direct');

    const listener = http.createServer(server.middlewares);
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    httpServers.push(listener);
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    const stylesheet = await fetch(`${origin}/src/ClientCard.module.scss?direct`, {
      headers: { accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style' },
    });
    const cssModule = await fetch(`${origin}/src/ClientCard.module.scss`, {
      headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
    });

    expect(stylesheet.headers.get('content-type')).toContain('text/css');
    expect(await stylesheet.text()).toContain('color: rgb(1, 2, 3)');
    expect(cssModule.headers.get('content-type')).toContain('text/javascript');
    expect(await cssModule.text()).toContain('__vite__updateStyle');
  });
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-dev-stylesheet-identity-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2)
  );
  await writeFile(path.join(root, 'src/entry.browser.ts'), 'export {};\n');
  await writeFile(path.join(root, 'src/entry.rsc.ts'), 'export {};\n');
  await writeFile(path.join(root, 'src/entry.ssr.ts'), 'export {};\n');
  await writeFile(
    path.join(root, 'src/ClientCard.tsx'),
    `'use client';\nimport styles from './ClientCard.module.scss';\nexport default function ClientCard() { return <div className={styles.card}>card</div>; }\n`
  );
  await writeFile(
    path.join(root, 'src/ClientCard.module.scss'),
    '.card { color: rgb(1, 2, 3); }\n'
  );
  return root;
}
