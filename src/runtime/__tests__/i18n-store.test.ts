import { beforeEach, describe, expect, it } from 'vitest';

import { getI18n, getI18nLocale, registerServerI18nReader, setClientI18n } from '../i18n-store';
import type * as I18nStore from '../i18n-store';

describe('i18n-store', () => {
  beforeEach(() => {
    registerServerI18nReader(() => null);
    setClientI18n(null);
  });

  it('shares client i18n state across duplicated module instances', async () => {
    const copy = await importStoreCopy('client');

    setClientI18n({
      locale: 'zh',
      messages: { nav: { home: '首页' } },
    });

    expect(copy.getI18n('nav.home')).toBe('首页');
    expect(copy.getI18nLocale()).toBe('zh');

    copy.setClientI18n({
      locale: 'en',
      messages: { nav: { home: 'Home' } },
    });

    expect(getI18n('nav.home')).toBe('Home');
    expect(getI18nLocale()).toBe('en');
  });

  it('shares server reader across duplicated module instances', async () => {
    const copy = await importStoreCopy('server');

    copy.registerServerI18nReader(() => ({
      locale: 'fr',
      messages: { nav: { home: 'Accueil' } },
    }));

    expect(getI18n('nav.home')).toBe('Accueil');
    expect(getI18nLocale()).toBe('fr');
  });
});

async function importStoreCopy(name: string): Promise<typeof I18nStore> {
  const modulePath = `../i18n-store?copy=${name}`;
  return (await import(/* @vite-ignore */ modulePath)) as typeof I18nStore;
}
