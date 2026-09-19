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
    const intl = await hooks.loadIntl(new Request('https://example.com/ja'));
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
});
