import { describe, expect, it } from 'vitest';

import { createRscRenderRequest, parseRenderRequest } from '../request';

describe('RSC request protocol', () => {
  it('carries a development style generation in an internal request header', () => {
    const request = createRscRenderRequest('http://localhost:3000/articles', undefined, {
      devStyleGeneration: 7,
    });

    expect(request.headers.get('x-novel-isr-dev-style-generation')).toBe('7');
    expect(parseRenderRequest(request).devStyleGeneration).toBe(7);
  });

  it('omits the development style protocol when no generation is supplied', () => {
    const request = createRscRenderRequest('http://localhost:3000/articles');

    expect(request.headers.has('x-novel-isr-dev-style-generation')).toBe(false);
    expect(parseRenderRequest(request).devStyleGeneration).toBeUndefined();
  });

  it('rejects malformed development style generations', () => {
    const request = new Request('http://localhost:3000/articles_.rsc', {
      headers: { 'x-novel-isr-dev-style-generation': '7x' },
    });

    expect(() => parseRenderRequest(request)).toThrow(/invalid development style generation/i);
  });
});
