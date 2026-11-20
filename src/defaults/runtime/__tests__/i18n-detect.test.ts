import { describe, expect, it } from 'vitest';

import { defineSiteHooks } from '../defineSiteHooks';

const LOCALES = ['zh-hans', 'en-us', 'ja', 'fr'] as const;

function makeHooks() {
  return defineSiteHooks({
    intl: {
      locales: LOCALES,
      defaultLocale: 'zh-hans',
      prefixDefault: true,
      // 本地加载器回显 locale，便于断言检测结果
      load: async locale => ({ locale, messages: {} }),
    },
  });
}

describe('i18n locale detection', () => {
  it('detects locale from the URL pathname prefix', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(
      new Request('https://example.com/ja', { headers: { 'accept-language': '*;q=0' } })
    );
    expect(intl?.locale).toBe('ja');
  });

  it('strips the _.rsc suffix before detecting locale (RSC navigation)', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(new Request('https://example.com/ja_.rsc'));
    expect(intl?.locale).toBe('ja');
  });

  it('falls back to default locale for the unprefixed root path', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(new Request('https://example.com/'));
    expect(intl?.locale).toBe('zh-hans');
  });

  it('tries lower-ranked supported ranges after an unsupported preference', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(
      new Request('https://example.com/', {
        headers: { 'accept-language': 'de,ja;q=0.8,zh;q=0' },
      })
    );
    expect(intl?.locale).toBe('ja');
  });

  it('lets a valid locale cookie override the header', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(
      new Request('https://example.com/', {
        headers: { cookie: 'locale=ja', 'accept-language': '*;q=0' },
      })
    );
    expect(intl?.locale).toBe('ja');
  });

  it('negotiates a locale when the cookie names an unsupported locale', async () => {
    const hooks = makeHooks();
    const intl = await hooks.loadIntl(
      new Request('https://example.com/', {
        headers: { cookie: 'locale=de', 'accept-language': 'ja,zh;q=0' },
      })
    );
    expect(intl?.locale).toBe('ja');
  });

  it('rejects a request when the header excludes every locale', async () => {
    const hooks = makeHooks();
    const req = new Request('https://example.com/', {
      headers: { 'accept-language': '*;q=0' },
    });
    await expect(hooks.loadIntl(req)).rejects.toThrow(RangeError);
  });

  it('uses the first configured locale when there is no explicit default', async () => {
    const hooks = defineSiteHooks({ intl: { locales: ['ja', 'fr'] } });
    const req = new Request('https://example.com/');
    expect((await hooks.loadIntl(req))?.locale).toBe('ja');
  });
});
