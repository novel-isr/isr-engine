import { describe, expect, it } from 'vitest';
import { isRscNavigation, shouldPrefetch, createPrefetcher } from './client-navigation-policy';
const current = 'https://example.com/page?q=1';
describe('client navigation policy', () => {
  it('leaves same document anchors and current URLs to the browser', () => {
    expect(isRscNavigation(current + '#section', current)).toBe(false);
    expect(isRscNavigation(current, current)).toBe(false);
    expect(isRscNavigation('https://example.com/page?q=2#section', current)).toBe(true);
    expect(isRscNavigation('mailto:test@example.com', current)).toBe(false);
  });
  it('honors intent and disabled policies without changing navigation', () => {
    expect(shouldPrefetch('/next', current, 'intent', 'viewport')).toBe(false);
    expect(shouldPrefetch('/next', current, 'intent', 'intent')).toBe(true);
    expect(shouldPrefetch('/next', current, 'false', 'intent')).toBe(false);
    expect(shouldPrefetch('#section', current, undefined, 'intent')).toBe(false);
    expect(isRscNavigation('/next', current)).toBe(true);
  });
  it('respects data saver and slow connections even for intent', () => {
    expect(shouldPrefetch('/next', current, undefined, 'intent', { saveData: true })).toBe(false);
    expect(shouldPrefetch('/next', current, undefined, 'viewport', { effectiveType: '2g' })).toBe(
      false
    );
    expect(
      shouldPrefetch('/next', current, undefined, 'intent', { effectiveType: 'slow-2g' })
    ).toBe(false);
  });
  it('catches failures, retries, and deduplicates URL fragments', async () => {
    const requests: string[] = [];
    const prefetch = createPrefetcher(async url => {
      requests.push(url);
      if (requests.length === 1) throw new Error('offline');
      return { ok: true };
    });
    await prefetch('https://example.com/next#one');
    await prefetch('https://example.com/next#two');
    await prefetch('https://example.com/next#three');
    expect(requests).toEqual(['https://example.com/next_.rsc', 'https://example.com/next_.rsc']);
  });
  it('bounds successful deduplication and retries unsuccessful HTTP responses', async () => {
    const requests: string[] = [];
    const prefetch = createPrefetcher(async url => {
      requests.push(url);
      return { ok: !url.includes('bad') };
    }, 2);
    for (const path of ['bad', 'bad', 'a', 'b', 'c', 'a'])
      await prefetch('https://example.com/' + path);
    expect(requests).toHaveLength(6);
  });
});
