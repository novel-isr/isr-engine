import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import {
  isInternalNavigationHistoryMutation,
  syncBrowserUrlToFinalRedirect,
} from '../navigation-history.client';

function responseAt(url: string): Pick<Response, 'url'> {
  return { url };
}

describe('RSC navigation history synchronization', () => {
  it('does not mistake a completed non-redirect response for a redirect after a newer navigation', () => {
    const browser = new Window({ url: 'http://localhost:3000/' });
    const originalReplaceState = browser.history.replaceState.bind(browser.history);
    let replacements = 0;
    browser.history.replaceState = (...args) => {
      replacements += 1;
      return originalReplaceState(...args);
    };

    syncBrowserUrlToFinalRedirect(
      responseAt('http://localhost:3000/article_.rsc'),
      'http://localhost:3000/article_.rsc',
      browser as unknown as Window
    );

    expect(replacements).toBe(0);
    expect(browser.location.pathname).toBe('/');
    browser.close();
  });

  it('ignores a real redirect response when its requesting location is stale', () => {
    const browser = new Window({ url: 'http://localhost:3000/latest' });
    const originalReplaceState = browser.history.replaceState.bind(browser.history);
    let replacements = 0;
    browser.history.replaceState = (...args) => {
      replacements += 1;
      return originalReplaceState(...args);
    };

    syncBrowserUrlToFinalRedirect(
      responseAt('http://localhost:3000/canonical_.rsc'),
      'http://localhost:3000/legacy_.rsc',
      browser as unknown as Window
    );

    expect(replacements).toBe(0);
    expect(browser.location.pathname).toBe('/latest');
    browser.close();
  });

  it('marks the accepted redirect replacement as internal and preserves the current hash', () => {
    const browser = new Window({ url: 'http://localhost:3000/legacy?from=nav#section' });
    const originalReplaceState = browser.history.replaceState.bind(browser.history);
    const internalStates: boolean[] = [];
    browser.history.replaceState = (...args) => {
      internalStates.push(isInternalNavigationHistoryMutation());
      return originalReplaceState(...args);
    };

    syncBrowserUrlToFinalRedirect(
      responseAt('http://localhost:3000/canonical_.rsc?from=server'),
      'http://localhost:3000/legacy_.rsc?from=nav',
      browser as unknown as Window
    );

    expect(internalStates).toEqual([true]);
    expect(browser.location.pathname).toBe('/canonical');
    expect(browser.location.search).toBe('?from=server');
    expect(browser.location.hash).toBe('#section');
    expect(isInternalNavigationHistoryMutation()).toBe(false);
    browser.close();
  });
});
