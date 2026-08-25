import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import vitePluginRsc from '@vitejs/plugin-rsc';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import {
  createDevCssLifecyclePlugins,
  DEV_CSS_HANDOFF_RESOLVED_ID,
  VITE_RSC_REMOVE_DUPLICATE_CSS_ID,
} from '../createDevCssHandoffPlugin';
import { createIsrPlugin } from '../createIsrPlugin';

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

  it('instruments client-reference styles after the standard engine RSC proxy transform', async () => {
    const root = await createFixture();
    const server = await createServer({
      root,
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

    const transformed = await server.environments.rsc.transformRequest('/src/ClientCard.tsx');
    const boundaryUrl = `/@fs/${path.resolve(process.cwd(), 'src/runtime/boundary.tsx')}`;
    const transformedBoundary = await server.environments.rsc.transformRequest(boundaryUrl);

    const pluginNames = server.config.plugins.map(plugin => plugin.name);
    expect(pluginNames.indexOf('isr:dev-css-handoff')).toBeLessThan(
      pluginNames.indexOf('rsc:use-client')
    );
    expect(pluginNames.indexOf('rsc:use-client')).toBeLessThan(
      pluginNames.indexOf('isr:dev-client-reference-styles')
    );
    expect(pluginNames.indexOf('vite:css-post')).toBeLessThan(
      pluginNames.indexOf('isr:dev-style-registry')
    );

    expect(transformed?.code).toContain('registerClientReference(');
    expect(transformed?.code.match(/registerDevClientReferenceStyles\)/g)).toHaveLength(1);
    expect(transformed?.code).toContain('/src/ClientCard.module.scss');
    expect(transformedBoundary?.code).toContain('registerClientReference(');
    expect(transformedBoundary?.code.match(/registerDevClientReferenceStyles\)/g)).toHaveLength(1);
    expect(transformedBoundary?.code).toContain('/src/runtime/boundary.module.css');

    const rscEnvironment = server.environments.rsc as typeof server.environments.rsc & {
      runner: { import(id: string): Promise<unknown> };
    };
    const rscEntry = (await rscEnvironment.runner.import('/src/entry.rsc.tsx')) as {
      render(): Promise<{
        devStyleIds: string[];
        stream: ReadableStream<Uint8Array>;
      }>;
    };
    const rendered = await rscEntry.render();
    await new Response(rendered.stream).text();

    expect(rendered.devStyleIds).toContain('/src/ClientCard.module.scss');
  });

  it('keeps query-bearing virtual client references distinct through the standard engine pipeline', async () => {
    const root = await createFixture();
    const virtualClientId = 'virtual:fixture/client-card';
    const loadedClientIds: string[] = [];
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        hmr: false,
        fs: { allow: [root, process.cwd()] },
      },
      plugins: [
        {
          name: 'fixture:query-bearing-client-reference',
          resolveId(id) {
            if (id.startsWith(virtualClientId)) return `\0${id}`;
          },
          load(id) {
            if (!id.startsWith(`\0${virtualClientId}`)) return;
            loadedClientIds.push(id);
            const queryStart = id.indexOf('?');
            const variant = new URLSearchParams(
              queryStart === -1 ? '' : id.slice(queryStart + 1)
            ).get('variant');
            const stylesheet =
              variant === 'dark'
                ? '/src/VirtualDark.scss'
                : variant === 'light'
                  ? '/src/VirtualLight.scss'
                  : '/src/VirtualFallback.scss';
            return (
              `'use client';\n` +
              `import ${JSON.stringify(stylesheet)};\n` +
              `export default function VirtualCard() { return null; }\n`
            );
          },
        },
        ...createIsrPlugin({ root, isrCache: { enabled: false } }),
      ],
    });
    viteServers.push(server);

    const darkId = `${virtualClientId}?variant=dark`;
    const lightId = `${virtualClientId}?variant=light`;
    const dark = await server.environments.rsc.transformRequest(`\0${darkId}`);
    const light = await server.environments.rsc.transformRequest(`\0${lightId}`);

    expect(dark?.code).toContain(`/@id/__x00__${darkId}`);
    expect(dark?.code).toContain('/src/VirtualDark.scss');
    expect(dark?.code).not.toContain('/src/VirtualLight.scss');
    expect(dark?.code).not.toContain('/src/VirtualFallback.scss');
    expect(light?.code).toContain(`/@id/__x00__${lightId}`);
    expect(light?.code).toContain('/src/VirtualLight.scss');
    expect(light?.code).not.toContain('/src/VirtualDark.scss');
    expect(light?.code).not.toContain('/src/VirtualFallback.scss');
    expect(loadedClientIds).toContain(`\0${darkId}`);
    expect(loadedClientIds).toContain(`\0${lightId}`);
    expect(loadedClientIds).not.toContain(`\0${virtualClientId}`);
  });

  it('separates the SSR stylesheet URL from the JavaScript CSS-module URL', async () => {
    const root = await createFixture();
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        hmr: false,
        fs: { allow: [root, process.cwd()] },
      },
      plugins: [
        ...createDevCssLifecyclePlugins(path.resolve(process.cwd(), 'src/defaults')),
        ...vitePluginRsc({
          entries: {
            client: '/src/entry.browser.ts',
            rsc: '/src/entry.rsc.tsx',
            ssr: '/src/entry.ssr.ts',
          },
        }),
      ],
    });
    viteServers.push(server);

    const lifecycleBoundary = await server.environments.client.pluginContainer.resolveId(
      VITE_RSC_REMOVE_DUPLICATE_CSS_ID
    );
    expect(lifecycleBoundary?.id).toBe(DEV_CSS_HANDOFF_RESOLVED_ID);
    const boundaryModule = await server.environments.client.pluginContainer.load(
      lifecycleBoundary!.id
    );
    expect(
      typeof boundaryModule === 'string' ? boundaryModule : boundaryModule?.code
    ).not.toContain('reconcileDocumentStyles');

    const clientReferenceId = '/src/ClientCard.tsx';
    const transformedClientReference =
      await server.environments.rsc.transformRequest(clientReferenceId);
    expect(transformedClientReference?.code).toContain('registerDevClientReferenceStyles');
    expect(transformedClientReference?.code).toContain('/src/ClientCard.module.scss');
    await server.environments.ssr.transformRequest('/src/ClientCard.tsx');
    const virtualId = `virtual:vite-rsc/css?type=ssr&id=${encodeURIComponent(clientReferenceId)}&lang.js`;
    const resolved = await server.environments.ssr.pluginContainer.resolveId(virtualId);
    expect(resolved).toBeTruthy();

    const transformed = await server.environments.ssr.transformRequest(resolved!.id);
    expect(transformed?.code).toContain('/src/ClientCard.module.scss?direct');

    const transformedPage = await server.environments.rsc.transformRequest('/src/Page.tsx');
    const rscCssId = transformedPage?.code.match(/virtual:vite-rsc\/css\?[^"']+/)?.[0];
    expect(rscCssId).toBeTruthy();
    const resolvedRscCss = await server.environments.rsc.pluginContainer.resolveId(rscCssId!);
    expect(resolvedRscCss).toBeTruthy();
    const transformedRscCss = await server.environments.rsc.transformRequest(resolvedRscCss!.id);
    expect(transformedRscCss?.code).toContain('prepareDevStyleDependencies');
    expect(transformedRscCss?.code).toContain('/src/Page.scss?direct');

    const rscEnvironment = server.environments.rsc as typeof server.environments.rsc & {
      runner: { import(id: string): Promise<unknown> };
    };
    const rscEntry = (await rscEnvironment.runner.import('/src/entry.rsc.tsx')) as {
      render(generation?: number): Promise<{
        devStyleIds: string[];
        stream: ReadableStream<Uint8Array>;
      }>;
    };
    const rendered = await rscEntry.render(3);
    const flight = await new Response(rendered.stream).text();
    expect([...rendered.devStyleIds].sort()).toEqual([
      '/src/ClientCard.module.scss',
      '/src/Page.scss',
    ]);
    expect(flight).toContain('__novel_isr_style_generation=3');
    expect(flight).toContain('not all');

    const initial = await rscEntry.render();
    const initialFlight = await new Response(initial.stream).text();
    expect(initialFlight).not.toContain('not all');

    const listener = http.createServer(server.middlewares);
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    httpServers.push(listener);
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    const stylesheet = await fetch(`${origin}/src/ClientCard.module.scss?direct`, {
      headers: { accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style' },
    });
    const generatedTransportStylesheet = await fetch(
      `${origin}/src/Page.scss?direct=&__novel_isr_style_generation=3`,
      { headers: { accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style' } }
    );
    const cssModule = await fetch(`${origin}/src/ClientCard.module.scss`, {
      headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
    });

    expect(stylesheet.headers.get('content-type')).toContain('text/css');
    expect(await stylesheet.text()).toContain('color: rgb(1, 2, 3)');
    expect(generatedTransportStylesheet.headers.get('content-type')).toContain('text/css');
    expect(await generatedTransportStylesheet.text()).toContain('display: block');
    expect(cssModule.headers.get('content-type')).toContain('text/javascript');
    const cssModuleCode = await cssModule.text();
    expect(cssModuleCode).toMatch(/export default\s*\{[^}]*["']?card["']?\s*:\s*card/);
    expect(cssModuleCode).toContain('virtual:novel-isr/dev-style-registry');
    expect(cssModuleCode).toContain('__novel_isr_dev_styles.publish(');
    expect(cssModuleCode).toContain('__novel_isr_dev_styles.prune(');
    expect(cssModuleCode).not.toMatch(/__vite__updateStyle\s*\(/);
    expect(cssModuleCode).not.toMatch(/__vite__removeStyle\s*\(/);

    const externalRoot = await mkdtemp(path.join(process.cwd(), '.tmp-dev-style-external-'));
    fixtureRoots.push(externalRoot);
    const externalStyle = path.join(externalRoot, 'Page.scss');
    await writeFile(externalStyle, '.external { color: rgb(4, 5, 6); }\n');
    const rootWrapper = await server.environments.client.transformRequest('/src/Page.scss');
    const semanticWrapper = await server.environments.client.transformRequest(
      '/src/Page.scss?theme=dark&t=stale'
    );
    const externalUrl = `/@fs/${externalStyle}`;
    const externalWrapper = await server.environments.client.transformRequest(externalUrl);

    expect(rootWrapper?.code).toContain('__novel_isr_dev_styles.publish("/src/Page.scss"');
    expect(semanticWrapper?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Page.scss?theme=dark"'
    );
    expect(externalWrapper?.code).toContain(
      `__novel_isr_dev_styles.publish(${JSON.stringify(externalUrl)}`
    );
    expect(externalWrapper?.code).not.toContain('__novel_isr_dev_styles.publish("/src/Page.scss"');
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
  await writeFile(
    path.join(root, 'src/app.tsx'),
    `export function App() { return <main>fixture</main>; }\n`
  );
  const declarationsUrl = pathToFileURL(
    path.resolve(process.cwd(), 'src/defaults/runtime/dev-style-declarations.server.ts')
  ).href;
  await writeFile(
    path.join(root, 'src/entry.rsc.tsx'),
    `import { renderToReadableStream } from '@vitejs/plugin-rsc/rsc';\n` +
      `import { declareDevClientReferenceStyles, runWithDevStyleDeclarationCollection } from ${JSON.stringify(declarationsUrl)};\n` +
      `import Page from './Page';\n` +
      `export async function render(generation?: number) {\n` +
      `  const devStyleIds: string[] = [];\n` +
      `  const stream = runWithDevStyleDeclarationCollection(devStyleIds, () =>\n` +
      `    renderToReadableStream({ root: <Page />, devStyleIds }, undefined, {\n` +
      `      onClientReference: declareDevClientReferenceStyles,\n` +
      `    }),\n` +
      `    { transportGeneration: generation },\n` +
      `  );\n` +
      `  return { devStyleIds, stream };\n` +
      `}\n`
  );
  await writeFile(path.join(root, 'src/entry.ssr.ts'), 'export {};\n');
  await writeFile(
    path.join(root, 'src/ClientCard.tsx'),
    `'use client';\nimport styles from './ClientCard.module.scss';\nexport function Badge() { return <span className={styles.card}>badge</span>; }\nexport default function ClientCard() { return <div className={styles.card}>card</div>; }\n`
  );
  await writeFile(
    path.join(root, 'src/ClientCard.module.scss'),
    '.card { color: rgb(1, 2, 3); }\n'
  );
  await writeFile(
    path.join(root, 'src/Page.tsx'),
    `import './Page.scss';\nimport ClientCard from './ClientCard';\nexport default function Page() { return <main><ClientCard /></main>; }\n`
  );
  await writeFile(path.join(root, 'src/Page.scss'), 'main { display: block; }\n');
  await writeFile(path.join(root, 'src/VirtualDark.scss'), '.virtual { color: black; }\n');
  await writeFile(path.join(root, 'src/VirtualLight.scss'), '.virtual { color: white; }\n');
  await writeFile(path.join(root, 'src/VirtualFallback.scss'), '.virtual { color: red; }\n');
  return root;
}
