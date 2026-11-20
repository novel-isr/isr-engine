import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleLink } from '../../../runtime/LocaleLink';
import { resolveI18nConfig } from '../../../runtime/i18n';
import { installLocaleLinks } from '../locale-links.client';

let browser: Window | undefined;

function pageWithLocaleLink(locale: string, rememberLocale?: boolean, prefixDefault = true) {
  const window = new Window({ url: 'https://example.com/en/books?from=home#details' });
  browser = window;
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLAnchorElement', window.HTMLAnchorElement);
  vi.stubGlobal('MouseEvent', window.MouseEvent);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  window.document.body.innerHTML = renderToStaticMarkup(
    createElement(
      LocaleLink,
      {
        config: resolveI18nConfig({
          locales: ['en', 'zh-CN'],
          defaultLocale: 'en',
          prefixDefault,
          rememberLocale,
        }),
        locale,
      },
      'Switch language'
    )
  );
  const link = window.document.querySelector('a')!;
  const links = installLocaleLinks();
  return { window, link, links };
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  vi.unstubAllGlobals();
});

describe('LocaleLink preference', () => {
  it('writes the preference only on activation, before a pending navigation', async () => {
    const { window, link, links } = pageWithLocaleLink('zh-CN', true);
    expect(link.href).toBe('https://example.com/zh-CN/books?from=home#details');
    link.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    link.dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, button: 1 }));
    window.document.addEventListener(
      'click',
      event => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault();
      },
      { once: true }
    );
    link.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    );
    expect(window.document.cookie).toBe('');

    link.click();
    expect(window.document.cookie).toBe('isr_locale=zh-CN');
    expect(window.location.pathname).toBe('/en/books');
    links.connect();
    await Promise.resolve();
    expect(window.location.href).toBe('https://example.com/zh-CN/books?from=home#details');
  });

  it('leaves switching stateless by default', async () => {
    const { window, link, links } = pageWithLocaleLink('zh-CN');
    link.click();
    links.connect();
    await Promise.resolve();
    expect(window.location.pathname).toBe('/zh-CN/books');
    expect(window.document.cookie).toBe('');
  });

  it('leaves switching stateless when the default URL is unprefixed', async () => {
    const { window, link, links } = pageWithLocaleLink('zh-CN', true, false);
    link.click();
    links.connect();
    await Promise.resolve();
    expect(window.location.pathname).toBe('/zh-CN/books');
    expect(window.document.cookie).toBe('');
  });

  it('leaves unsupported locales disabled without writing a preference', () => {
    const { window, link } = pageWithLocaleLink('fr', true);
    link.click();
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.hasAttribute('href')).toBe(false);
    expect(window.document.cookie).toBe('');
  });
});
