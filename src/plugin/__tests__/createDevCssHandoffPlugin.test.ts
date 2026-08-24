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
});
