import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import { createIsrPlugin } from '../createIsrPlugin';

const fixtureRoots: string[] = [];
const viteServers: ViteDevServer[] = [];
const httpServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(viteServers.splice(0).map(server => server.close()));
  await Promise.all(
    httpServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('default client entry dependency optimization', () => {
  it('keeps the first cold-cache optimized dependency URLs valid', async () => {
    const root = await createFixture();
    const server = await createServer({
      root,
      cacheDir: path.join(root, 'node_modules/.vite'),
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        hmr: false,
        fs: { allow: [root, process.cwd()] },
      },
      plugins: createIsrPlugin({ root, isrCache: { enabled: false } }),
    });
    viteServers.push(server);

    const client = server.environments.client;
    const optimizer = client.depsOptimizer;
    expect(optimizer).toBeDefined();
    await optimizer!.scanProcessing;

    const initialDependency =
      optimizer!.metadata.optimized['rsc-html-stream/client'] ??
      optimizer!.metadata.discovered['rsc-html-stream/client'];
    expect(initialDependency).toBeDefined();
    const initialBrowserHash = optimizer!.metadata.browserHash;

    const entry = await client.transformRequest('\0virtual:novel-isr/client-entry');
    const defaultEntryUrl = entry?.code.match(
      /from\s+["']([^"']*\/src\/defaults\/runtime\/defineClientEntry\.tsx)["']/
    )?.[1];
    expect(defaultEntryUrl).toBeDefined();

    const defaultEntry = await client.transformRequest(defaultEntryUrl!);
    const optimizedUrl = defaultEntry?.code.match(
      /["'](\/node_modules\/\.vite\/deps\/rsc-html-stream_client\.js\?v=[^"']+)["']/
    )?.[1];
    expect(optimizedUrl).toBeDefined();
    expect(new URL(`http://fixture${optimizedUrl}`).searchParams.get('v')).toBe(
      initialDependency!.browserHash
    );

    const listener = http.createServer(server.middlewares);
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    httpServers.push(listener);
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}${optimizedUrl}`, {
      headers: { connection: 'close' },
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(responseBody).toContain('export');
    expect(optimizer!.metadata.browserHash).toBe(initialBrowserHash);
    expect(optimizer!.metadata.discovered['rsc-html-stream/client']).toBeUndefined();
    expect(optimizer!.metadata.optimized['rsc-html-stream/client']?.browserHash).toBe(
      initialDependency!.browserHash
    );
  });
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-cold-start-optimize-deps-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2)
  );
  await writeFile(
    path.join(root, 'src/app.tsx'),
    `export function App() { return <main>cold start</main>; }\n`
  );
  return root;
}
