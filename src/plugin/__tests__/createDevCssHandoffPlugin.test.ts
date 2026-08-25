import { describe, expect, it } from 'vitest';

import {
  createDevCssHandoffPlugin,
  DEV_CSS_HANDOFF_RESOLVED_ID,
  VITE_RSC_REMOVE_DUPLICATE_CSS_ID,
} from '../createDevCssHandoffPlugin';

describe('createDevCssHandoffPlugin', () => {
  it('owns plugin-rsc dev stylesheet cleanup before the upstream virtual module resolves', async () => {
    const plugin = createDevCssHandoffPlugin('/engine/defaults');
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;

    expect(plugin.enforce).toBe('pre');
    expect(resolveId(VITE_RSC_REMOVE_DUPLICATE_CSS_ID)).toBe(DEV_CSS_HANDOFF_RESOLVED_ID);
    expect(load(DEV_CSS_HANDOFF_RESOLVED_ID)).toContain('handoffDevClientReferenceStyles');
  });

  it('gives development RSC stylesheet resources a CSS-only URL identity', async () => {
    const plugin = createDevCssHandoffPlugin('/engine/defaults');
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
    const plugin = createDevCssHandoffPlugin('/engine/defaults');
    const transform = plugin.transform as (
      code: string,
      id: string
    ) => Promise<{ code: string; map: null } | undefined>;

    expect(await transform('import styles from "/src/Page.module.scss";', '/src/Page.tsx')).toBe(
      undefined
    );
  });
});
