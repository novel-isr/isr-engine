import { describe, expect, it } from 'vitest';

import config from '../app/ssr.config.ts';

describe('bench app config', () => {
  it('uses top-level revalidate and no public cache/server hardening knobs', () => {
    expect(config.revalidate).toBe(60);
    expect(config).not.toHaveProperty('seo');
    expect(config).not.toHaveProperty('isr');
    expect(config.server).not.toHaveProperty('timeouts');
  });
});
