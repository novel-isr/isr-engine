import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createDevCssLifecyclePlugins,
  DEV_CSS_HANDOFF_RESOLVED_ID,
  DEV_STYLE_REGISTRY_ID,
  DEV_STYLE_REGISTRY_RESOLVED_ID,
  VITE_RSC_REMOVE_DUPLICATE_CSS_ID,
} from '../createDevCssHandoffPlugin';

describe('createDevCssLifecyclePlugins', () => {
  const defaultsDir = path.resolve(process.cwd(), 'src/defaults');

  it('owns plugin-rsc dev stylesheet cleanup before the upstream virtual module resolves', async () => {
    const [plugin] = createDevCssLifecyclePlugins(defaultsDir);
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;

    expect(plugin.enforce).toBe('pre');
    expect(resolveId(VITE_RSC_REMOVE_DUPLICATE_CSS_ID)).toBe(DEV_CSS_HANDOFF_RESOLVED_ID);
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain('DevCssLifecycleBoundary');
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain('React.useLayoutEffect');
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain(
      'devStyleRegistry.reconcileDocumentStyles()'
    );
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

  it('adds a post-CSS plugin that supplies the singleton client registry', async () => {
    const [prePlugin, postPlugin] = createDevCssLifecyclePlugins(defaultsDir);
    const resolveId = postPlugin.resolveId as (id: string) => string | undefined;
    const load = postPlugin.load as (id: string) => string | undefined;
    const transform = postPlugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;

    expect(prePlugin.enforce).toBe('pre');
    expect(postPlugin.enforce).toBe('post');
    expect(resolveId(DEV_STYLE_REGISTRY_ID)).toBe(DEV_STYLE_REGISTRY_RESOLVED_ID);
    expect(load(DEV_STYLE_REGISTRY_RESOLVED_ID)).toContain('createDevStyleRegistry(document)');
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
});
