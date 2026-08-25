import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  clientReferenceIdFromProxy,
  createDevCssLifecyclePlugins,
  DEV_CSS_HANDOFF_RESOLVED_ID,
  DEV_STYLE_REGISTRY_ID,
  DEV_STYLE_REGISTRY_RESOLVED_ID,
  instrumentDevRscStylesheetModule,
  VITE_RSC_REMOVE_DUPLICATE_CSS_ID,
} from '../createDevCssHandoffPlugin';

describe('createDevCssLifecyclePlugins', () => {
  const defaultsDir = path.resolve(process.cwd(), 'src/defaults');
  const pinnedRscRuntime = pathToFileURL(
    realpathSync(createRequire(import.meta.url).resolve('@vitejs/plugin-rsc/react/rsc/server'))
  ).href;
  const pinnedRscResources = (extraBody = '') => `
    import __vite_rsc_react__ from "react";
    import RemoveDuplicateServerCss from "virtual:vite-rsc/remove-duplicate-server-css";
    export const Resources = ((React, deps, RemoveDuplicateServerCss, precedence) => {
      return function Resources() {
        ${extraBody}
        return React.createElement(React.Fragment, null, [...deps.css.map((href) => React.createElement("link", {
          key: "css:" + href,
          rel: "stylesheet",
          ...precedence ? { precedence } : {},
          href,
          "data-rsc-css-href": href
        })), RemoveDuplicateServerCss && React.createElement(RemoveDuplicateServerCss, { key: "remove-duplicate-css" })]);
      };
    })(
      __vite_rsc_react__,
      { js: [], css: ["/src/Page.scss"] },
      RemoveDuplicateServerCss,
      "vite-rsc/importer-resources",
    );
  `;

  it('owns plugin-rsc dev stylesheet cleanup before the upstream virtual module resolves', async () => {
    const [plugin] = createDevCssLifecyclePlugins(defaultsDir);
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;

    expect(plugin.enforce).toBe('pre');
    expect(resolveId(VITE_RSC_REMOVE_DUPLICATE_CSS_ID)).toBe(DEV_CSS_HANDOFF_RESOLVED_ID);
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain('DevCssLifecycleBoundary');
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain(`import "${DEV_STYLE_REGISTRY_ID}"`);
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).not.toContain('React.useLayoutEffect');
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).not.toContain('reconcileDocumentStyles');
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).not.toContain('handoffDevClientReferenceStyles');
  });

  it('gives development RSC stylesheet resources a CSS-only URL identity', async () => {
    const [plugin] = createDevCssLifecyclePlugins(defaultsDir);
    const transform = plugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;
    const id = '\0virtual:vite-rsc/css?type=ssr&id=%2Fworkspace%2Fsrc%2FPage.tsx&lang.js';
    const code = `
      import React from "react";
      export default [
        "/src/Page.module.scss",
        "/src/theme.css?theme=dark",
        "/src/already.css?direct",
        "/assets/logo.svg"
      ];
    `;

    const result = await transform(code, id);

    expect(result?.code).toContain('"/src/Page.module.scss?direct"');
    expect(result?.code).toContain('"/src/theme.css?theme=dark&direct"');
    expect(result?.code).toContain('"/src/already.css?direct"');
    expect(result?.code).toContain('import React from "react"');
    expect(result?.code).toContain('"/assets/logo.svg"');
    expect(result?.map).toBeNull();
  });

  it('does not rewrite CSS imports outside plugin-rsc stylesheet resource modules', async () => {
    const [plugin] = createDevCssLifecyclePlugins(defaultsDir);
    const transform = plugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;

    expect(await transform('import styles from "/src/Page.module.scss";', '/src/Page.tsx')).toBe(
      undefined
    );
  });

  it('binds the pinned plugin-rsc server resource set to the current payload collector', () => {
    const id = '\0virtual:vite-rsc/css?type=rsc&id=%2Fworkspace%2Fsrc%2FPage.tsx&lang.js';
    const code = pinnedRscResources();

    const result = instrumentDevRscStylesheetModule(code, id, 'file:///engine/declarations.js');

    expect(result?.code).toContain('prepareDevStyleDependencies');
    expect(result?.code).toContain('getDevStyleTransportMedia');
    expect(result?.code).toContain('media: __novel_isr_transport_media');
    expect(result?.code).toContain('{ js: [], css: ["/src/Page.scss"] }');
    expect(result?.code).toContain('export function Resources()');
  });

  it('composes RSC instrumentation after direct transport canonicalization', async () => {
    const [plugin] = createDevCssLifecyclePlugins(defaultsDir);
    const transform = plugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;
    const id = '\0virtual:vite-rsc/css?type=rsc&id=%2Fworkspace%2Fsrc%2FPage.tsx&lang.js';

    const result = await transform(pinnedRscResources(), id);

    expect(result?.code).toContain('prepareDevStyleDependencies');
    expect(result?.code).toContain('"/src/Page.scss?direct"');
  });

  it('fails explicitly when the pinned plugin-rsc server resource shape changes', () => {
    const id = '\0virtual:vite-rsc/css?type=rsc&id=%2Fworkspace%2Fsrc%2FPage.tsx&lang.js';

    expect(() =>
      instrumentDevRscStylesheetModule(
        'export function Resources() { return null; }',
        id,
        'file:///engine/declarations.js'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc server stylesheet resource shape.*Page\.tsx/i);
  });

  it('rejects surplus or changed statements inside the pinned server Resources factory', () => {
    const id = '\0virtual:vite-rsc/css?type=rsc&id=%2Fworkspace%2Fsrc%2FPage.tsx&lang.js';

    expect(() =>
      instrumentDevRscStylesheetModule(
        pinnedRscResources('console.log("surplus");'),
        id,
        'file:///engine/declarations.js'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc server stylesheet resource shape/i);
    expect(() =>
      instrumentDevRscStylesheetModule(
        pinnedRscResources().replace('React.Fragment', '"main"'),
        id,
        'file:///engine/declarations.js'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc server stylesheet resource shape/i);
  });

  it('accepts only client proxies bound to the pinned plugin-rsc runtime and module identity', () => {
    const root = '/fixture';
    const validProxy = `
      import * as $$ReactServer from ${JSON.stringify(pinnedRscRuntime)};
      export const Badge = $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "Badge" + "' is called on server"); },
        "/src/ClientCard.tsx",
        "Badge"
      );
      export default $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server"); },
        "/src/ClientCard.tsx",
        "default"
      );
    `;

    expect(clientReferenceIdFromProxy(validProxy, '/src/ClientCard.tsx', root)).toBe(
      '/src/ClientCard.tsx'
    );
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace(
          '@vitejs/plugin-rsc/dist/react/rsc/server.js',
          'lookalike/rsc/server.js'
        ),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace(
          pinnedRscRuntime,
          'file:///tmp/fake/@vitejs/plugin-rsc/dist/react/rsc/server.js'
        ),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace(
          `() => { throw new Error("Unexpectedly client reference export '" + "Badge" + "' is called on server"); }`,
          'sideEffect()'
        ),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace(
          `"Unexpectedly client reference export '" + "Badge" + "' is called on server"`,
          `"Unexpectedly client reference export 'Badge' is called on server"`
        ),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace('export const Badge', 'export var Badge'),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replaceAll('$$ReactServer', 'Runtime'),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace('"/src/ClientCard.tsx"', '"/src/Other.tsx"'),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        validProxy.replace('"/src/ClientCard.tsx"', '"/%ZZ.tsx"'),
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      clientReferenceIdFromProxy(
        `${validProxy}\nconsole.log("surplus");`,
        '/src/ClientCard.tsx',
        root
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
  });

  it('binds root-relative client references to the configured project root exactly', () => {
    const proxyFor = (referenceId: string) => `
      import * as $$ReactServer from ${JSON.stringify(pinnedRscRuntime)};
      export default $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server"); },
        ${JSON.stringify(referenceId)},
        "default"
      );
    `;
    const validate = clientReferenceIdFromProxy;

    expect(
      validate(proxyFor('/src/ClientCard.tsx'), '/fixture/src/ClientCard.tsx', '/fixture')
    ).toBe('/src/ClientCard.tsx');
    expect(validate(proxyFor('/src/ClientCard.tsx'), '/src/ClientCard.tsx', '/fixture')).toBe(
      '/src/ClientCard.tsx'
    );
    expect(
      validate(
        proxyFor('/@fs/external/src/ClientCard.tsx'),
        '/external/src/ClientCard.tsx',
        '/fixture'
      )
    ).toBe('/@fs/external/src/ClientCard.tsx');
    expect(
      validate(proxyFor('/src/ClientCard.tsx'), 'C:\\fixture\\src\\ClientCard.tsx', 'C:\\fixture')
    ).toBe('/src/ClientCard.tsx');

    const packageTarget = '/fixture/node_modules/client-pkg/index.js';
    const packageReference =
      '/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/' +
      encodeURIComponent(packageTarget);
    expect(validate(proxyFor(packageReference), packageTarget, '/fixture')).toBe(packageReference);

    expect(() =>
      validate(proxyFor('/src/ClientCard.tsx'), '/different-root/src/ClientCard.tsx', '/fixture')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      validate(proxyFor('/src/ClientCard.tsx'), '/fixture/other/src/ClientCard.tsx', '/fixture')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      validate(
        proxyFor('/@fs/external/src/ClientCard.tsx'),
        '/different/external/src/ClientCard.tsx',
        '/fixture'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      validate(
        proxyFor(packageReference),
        '/different/node_modules/client-pkg/index.js',
        '/fixture'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() => validate(proxyFor('/src/a%2Fb.tsx'), '/fixture/src/a/b.tsx', '/fixture')).toThrow(
      /unsupported @vitejs\/plugin-rsc client reference proxy shape/i
    );
    expect(() =>
      validate(proxyFor('/@fs/fixture/src/a%2Fb.tsx'), '/fixture/src/a/b.tsx', '/fixture')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);

    const encodedSeparatorTarget = '/fixture/node_modules/a%2Fb/index.js';
    const encodedSeparatorReference =
      '/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/' +
      encodeURIComponent(encodedSeparatorTarget);
    expect(() =>
      validate(
        proxyFor(encodedSeparatorReference),
        '/fixture/node_modules/a/b/index.js',
        '/fixture'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
  });

  it('preserves the complete virtual client-reference query identity', () => {
    const proxyFor = (referenceId: string) => `
      import * as $$ReactServer from ${JSON.stringify(pinnedRscRuntime)};
      export default $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server"); },
        ${JSON.stringify(referenceId)},
        "default"
      );
    `;
    const validate = (referenceId: string, moduleId: string) =>
      clientReferenceIdFromProxy(proxyFor(referenceId), moduleId, '/fixture');

    expect(validate('/@id/__x00__virtual:fixture/card', '\0virtual:fixture/card')).toBe(
      '/@id/__x00__virtual:fixture/card'
    );
    expect(
      validate('/@id/__x00__virtual:fixture/card?theme=dark', '\0virtual:fixture/card?theme=dark')
    ).toBe('/@id/__x00__virtual:fixture/card?theme=dark');

    expect(() =>
      validate('/@id/__x00__virtual:fixture/card?theme=light', '\0virtual:fixture/card?theme=dark')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      validate('/@id/__x00__virtual:fixture/a%2Fb?theme=dark', '\0virtual:fixture/a/b?theme=dark')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
    expect(() =>
      validate('/@id/__x00__virtual:fixture/card%3Ftheme=dark', '\0virtual:fixture/card?theme=dark')
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape/i);
  });

  it('does not treat a non-prologue use-client string as a client reference target', async () => {
    const [prePlugin, clientReferencePlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const preTransform = prePlugin!.transform as (code: string, id: string) => unknown;
    const postTransform = clientReferencePlugin!.transform as (
      code: string,
      id: string
    ) => Promise<unknown>;
    const code = `const marker = 'not a directive';\n'use client';\nexport const NotRsc = marker;`;

    await preTransform.call({ environment: { name: 'rsc' } }, code, '/src/NotRsc.tsx');
    await expect(
      postTransform.call({ environment: { name: 'rsc' } }, code, '/src/NotRsc.tsx')
    ).resolves.toBeUndefined();
  });

  it('forgets a prior client-reference target when HMR removes its directive', async () => {
    const [prePlugin, clientReferencePlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const preTransform = prePlugin!.transform as (code: string, id: string) => unknown;
    const postTransform = clientReferencePlugin!.transform as (
      code: string,
      id: string
    ) => Promise<unknown>;
    const context = { environment: { name: 'rsc' } };
    const id = '/src/NotRsc.tsx';

    await preTransform.call(context, `'use client';\nexport default function Old() {}`, id);
    await preTransform.call(context, 'export default function NotRsc() {}', id);

    await expect(
      postTransform.call(context, 'export default function NotRsc() {}', id)
    ).resolves.toBeUndefined();
  });

  it('fails explicitly when the pinned plugin-rsc client reference proxy shape changes', () => {
    expect(() =>
      clientReferenceIdFromProxy(
        'export default registerReference("/src/ClientCard.tsx")',
        '/src/ClientCard.tsx',
        '/fixture'
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc client reference proxy shape.*ClientCard\.tsx/i);
  });

  it.each([
    ['parser recovery', '}'],
    [
      'duplicate default',
      `export default $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server") },
        "/src/ClientCard.tsx",
        "default"
      );`,
    ],
    [
      'duplicate named export',
      `export const Badge = $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "Badge" + "' is called on server") },
        "/src/ClientCard.tsx",
        "Badge"
      );`,
    ],
  ])('rejects %s in an otherwise supported client proxy', (_label, surplus) => {
    const proxy = `
      import * as $$ReactServer from ${JSON.stringify(pinnedRscRuntime)};
      export const Badge = $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "Badge" + "' is called on server") },
        "/src/ClientCard.tsx",
        "Badge"
      );
      export default $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server") },
        "/src/ClientCard.tsx",
        "default"
      );
      ${surplus}
    `;

    expect(() => clientReferenceIdFromProxy(proxy, '/src/ClientCard.tsx', '/fixture')).toThrow(
      /unsupported @vitejs\/plugin-rsc client reference proxy shape/i
    );
  });

  it('rejects a named wrapper whose reference name conflicts with its export identity', () => {
    const proxy = `
      import * as $$ReactServer from ${JSON.stringify(pinnedRscRuntime)};
      export const Badge = $$ReactServer.registerClientReference(
        () => { throw new Error("Unexpectedly client reference export '" + "Badge" + "' is called on server") },
        "/src/ClientCard.tsx",
        "default"
      );
    `;

    expect(() => clientReferenceIdFromProxy(proxy, '/src/ClientCard.tsx', '/fixture')).toThrow(
      /unsupported @vitejs\/plugin-rsc client reference proxy shape/i
    );
  });

  it('adds a post-CSS plugin that supplies the singleton client registry', async () => {
    const plugins = createDevCssLifecyclePlugins(defaultsDir);
    const prePlugin = plugins.find(plugin => plugin.name === 'isr:dev-css-handoff')!;
    const postPlugin = plugins.find(plugin => plugin.name === 'isr:dev-style-registry')!;
    const resolveId = postPlugin.resolveId as (id: string) => string | undefined;
    const load = postPlugin.load as (id: string) => string | undefined;
    const transform = postPlugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;

    expect(prePlugin.enforce).toBe('pre');
    expect(postPlugin.enforce).toBe('post');
    expect(resolveId(DEV_STYLE_REGISTRY_ID)).toBe(DEV_STYLE_REGISTRY_RESOLVED_ID);
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain('createDevStyleRegistry(document,');
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain('registerDevStyleRegistry');
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain(
      'onRscCommit: completeDevStyleNavigation'
    );
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain(
      "import.meta.hot?.on('vite:beforeUpdate'"
    );
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain(
      "import.meta.hot?.on('vite:afterUpdate'"
    );
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain("import.meta.hot?.on('vite:error'");

    const result = await transform(
      `
        import { updateStyle, removeStyle } from "/@vite/client";
        updateStyle("/src/Card.css", ".card{color:green}");
        import.meta.hot.prune(() => removeStyle("/src/Card.css"));
      `,
      '/src/Card.css'
    );

    expect(result?.code).toContain(`from "${DEV_STYLE_REGISTRY_ID}"`);
    expect(result?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Card.css", ".card{color:green}")'
    );
  });

  it('preserves semantic queries when only the clean client graph node is available', async () => {
    const [prePlugin, , postPlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const configureServer = prePlugin!.configureServer as (server: unknown) => void;
    configureServer({
      config: { root: '/workspace/app' },
      environments: {
        client: {
          moduleGraph: {
            getModuleById(id: string) {
              return id === '/workspace/app/src/theme.scss'
                ? { url: '/src/theme.scss' }
                : undefined;
            },
          },
        },
      },
    });
    const transform = postPlugin!.transform as (
      code: string,
      id: string
    ) => Promise<{
      code: string;
      map: null;
    }>;

    const result = await transform.call(
      { environment: { name: 'client' } },
      `
        import { updateStyle, removeStyle } from "/@vite/client";
        const styleId = "/workspace/app/src/theme.scss?theme=dark";
        updateStyle(styleId, ".theme{color:green}");
        import.meta.hot.prune(() => removeStyle(styleId));
      `,
      '/workspace/app/src/theme.scss?theme=dark&t=123'
    );

    expect(result.code).toContain(
      '__novel_isr_dev_styles.publish("/src/theme.scss?theme=dark", ".theme{color:green}")'
    );
  });

  it('uses an exact graph URL for a filename containing an encoded query delimiter', async () => {
    const [prePlugin, , postPlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const resolvedId = '/workspace/app/src/a%3Fb.scss';
    const configureServer = prePlugin!.configureServer as (server: unknown) => void;
    configureServer({
      config: { root: '/workspace/app' },
      environments: {
        client: {
          moduleGraph: {
            getModuleById(id: string) {
              return id === resolvedId ? { url: '/src/a%3Fb.scss' } : undefined;
            },
          },
        },
      },
    });
    const transform = postPlugin!.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null }>;

    const result = await transform.call(
      { environment: { name: 'client' } },
      `
        import { updateStyle, removeStyle } from "/@vite/client";
        const styleId = ${JSON.stringify(resolvedId)};
        updateStyle(styleId, ".encoded{color:green}");
        import.meta.hot.prune(() => removeStyle(styleId));
      `,
      resolvedId
    );

    expect(result.code).toContain(
      '__novel_isr_dev_styles.publish("/src/a%3Fb.scss", ".encoded{color:green}")'
    );
    expect(result.code).not.toContain('__novel_isr_dev_styles.publish("/src/a?b.scss="');
  });

  it('rejects an exact graph URL that drops a resolved semantic query', async () => {
    const [prePlugin, , postPlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const resolvedId = '/workspace/app/src/theme.scss?theme=dark&t=123';
    const configureServer = prePlugin!.configureServer as (server: unknown) => void;
    configureServer({
      config: { root: '/workspace/app' },
      environments: {
        client: {
          moduleGraph: {
            getModuleById(id: string) {
              return id === resolvedId ? { url: '/src/theme.scss' } : undefined;
            },
          },
        },
      },
    });
    const transform = postPlugin!.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null }>;

    expect(() =>
      transform.call(
        { environment: { name: 'client' } },
        `
          import { updateStyle, removeStyle } from "/@vite/client";
          const styleId = "/src/theme.scss";
          updateStyle(styleId, ".theme{color:green}");
          import.meta.hot.prune(() => removeStyle(styleId));
        `,
        resolvedId
      )
    ).toThrow(/semantic query.*does not match/i);
  });

  it('allows transport query differences and equivalent semantic query ordering', async () => {
    const [prePlugin, , postPlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const configureServer = prePlugin!.configureServer as (server: unknown) => void;
    const exactNodes = new Map([
      ['/workspace/app/src/plain.scss?t=123', { url: '/src/plain.scss?v=456' }],
      [
        '/workspace/app/src/theme.scss?theme=dark&mode=wide&t=123',
        { url: '/src/theme.scss?mode=wide&theme=dark&v=456' },
      ],
    ]);
    configureServer({
      config: { root: '/workspace/app' },
      environments: {
        client: { moduleGraph: { getModuleById: (id: string) => exactNodes.get(id) } },
      },
    });
    const transform = postPlugin!.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null }>;
    const wrapper = (styleId: string) => `
      import { updateStyle, removeStyle } from "/@vite/client";
      const id = ${JSON.stringify(styleId)};
      updateStyle(id, ".theme{color:green}");
      import.meta.hot.prune(() => removeStyle(id));
    `;

    expect(
      transform.call(
        { environment: { name: 'client' } },
        wrapper('/workspace/app/src/plain.scss'),
        '/workspace/app/src/plain.scss?t=123'
      )
    ).toMatchObject({
      code: expect.stringContaining('__novel_isr_dev_styles.publish("/src/plain.scss"'),
    });
    expect(
      transform.call(
        { environment: { name: 'client' } },
        wrapper('/workspace/app/src/theme.scss?mode=wide&theme=dark'),
        '/workspace/app/src/theme.scss?theme=dark&mode=wide&t=123'
      )
    ).toMatchObject({
      code: expect.stringContaining(
        '__novel_isr_dev_styles.publish("/src/theme.scss?mode=wide&theme=dark"'
      ),
    });
  });
});
