import { describe, expect, it, vi } from 'vitest';

describe('RequestContext', () => {
  it('shares one AsyncLocalStorage across duplicated module instances', async () => {
    const first = await import('../RequestContext');
    vi.resetModules();
    const second = await import('../RequestContext');

    expect(second.requestContext).toBe(first.requestContext);

    await first.requestContext.run(
      {
        traceId: 'trace-ab',
        requestId: 'req-ab',
        anonId: 'anon-ab',
        flags: { 'hero-style': 'bold' },
      },
      async () => {
        expect(second.getRequestContext()?.flags?.['hero-style']).toBe('bold');
      }
    );
  });
});
