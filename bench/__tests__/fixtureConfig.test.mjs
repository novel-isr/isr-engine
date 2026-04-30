import { describe, expect, it } from 'vitest';

import config from '../fixture/ssr.config.ts';

describe('bench fixture config', () => {
  it('keeps socket request caps above short benchmark traffic', () => {
    expect(config.server?.timeouts?.maxRequestsPerSocket).toBeGreaterThanOrEqual(1_000_000);
  });
});
