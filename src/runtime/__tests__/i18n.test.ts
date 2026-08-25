import { describe, expect, it } from 'vitest';
import { alternates, negotiateLocale, parseLocale, resolveI18nConfig, withLocale } from '../i18n';

describe('parseLocale', () => {
  const cfg = { locales: ['zh', 'en'], defaultLocale: 'zh' };

  it('strips locale prefix and reports hasPrefix=true', () => {
    expect(parseLocale('/en/books/1', cfg)).toEqual({
      locale: 'en',
      pathname: '/books/1',
      hasPrefix: true,
    });
  });

  it('falls back to defaultLocale when no prefix', () => {
    expect(parseLocale('/books/1', cfg)).toEqual({
      locale: 'zh',
      pathname: '/books/1',
      hasPrefix: false,
    });
  });

  it('handles root pathname', () => {
    expect(parseLocale('/en', cfg)).toEqual({
      locale: 'en',
      pathname: '/',
      hasPrefix: true,
    });
  });
});

describe('withLocale', () => {
  const cfg = { locales: ['zh', 'en'], defaultLocale: 'zh' };

  it('omits prefix for default locale', () => {
    expect(withLocale('/about', 'zh', cfg)).toBe('/about');
  });

  it('adds prefix for non-default locale', () => {
    expect(withLocale('/about', 'en', cfg)).toBe('/en/about');
  });

  it('respects prefixDefault=true', () => {
    expect(withLocale('/about', 'zh', { ...cfg, prefixDefault: true })).toBe('/zh/about');
  });

  it('throws on unknown locale', () => {
    expect(() => withLocale('/about', 'fr', cfg)).toThrow(/unknown locale/);
  });
});

describe('negotiateLocale', () => {
  const cfg = { locales: ['zh', 'en'], defaultLocale: 'en' };

  it('matches primary subtag', () => {
    expect(negotiateLocale('zh-CN,en;q=0.9', cfg)).toBe('zh');
  });

  it('falls back to default when no header', () => {
    expect(negotiateLocale(null, cfg)).toBe('en');
    expect(negotiateLocale(undefined, cfg)).toBe('en');
  });

  it('respects q-weights', () => {
    // en has q=1, zh has q=0.5 → en wins
    expect(negotiateLocale('zh;q=0.5,en', cfg)).toBe('en');
  });
});

describe('negotiateLocale —— 主语言回退（地区码）', () => {
  const regional = {
    locales: ['zh-hans', 'en-us', 'en-au', 'ja', 'fr', 'tr'],
    defaultLocale: 'zh-hans',
  };

  it("maps bare 'en' → first en-* locale", () => {
    expect(negotiateLocale('en', regional)).toBe('en-us');
  });

  it("maps 'en-GB' → first en-* locale", () => {
    expect(negotiateLocale('en-GB,en;q=0.9', regional)).toBe('en-us');
  });

  it("maps 'zh-CN' / 'zh' → zh-hans", () => {
    expect(negotiateLocale('zh-CN,zh;q=0.9', regional)).toBe('zh-hans');
    expect(negotiateLocale('zh', regional)).toBe('zh-hans');
  });

  it('still exact-matches regional locale code', () => {
    expect(negotiateLocale('en-au', regional)).toBe('en-au');
    expect(negotiateLocale('en-us', regional)).toBe('en-us');
  });

  it('still matches bare locale via primary subtag', () => {
    expect(negotiateLocale('ja-JP,ja;q=0.9', regional)).toBe('ja');
    expect(negotiateLocale('fr-FR', regional)).toBe('fr');
  });

  it('falls back to defaultLocale when nothing matches', () => {
    expect(negotiateLocale('de-DE', regional)).toBe('zh-hans');
  });
});

describe('alternates', () => {
  it('produces hreflang entries for every locale', () => {
    const cfg = { locales: ['zh', 'en'], defaultLocale: 'zh' };
    expect(alternates('/about', cfg)).toEqual([
      { hreflang: 'zh', href: '/about' },
      { hreflang: 'en', href: '/en/about' },
    ]);
  });
});

describe('resolveI18nConfig', () => {
  it('falls back to ["en"] when intl is missing', () => {
    expect(resolveI18nConfig(undefined)).toEqual({
      locales: ['en'],
      defaultLocale: 'en',
      prefixDefault: undefined,
    });
    expect(resolveI18nConfig(null)).toEqual({
      locales: ['en'],
      defaultLocale: 'en',
      prefixDefault: undefined,
    });
  });

  it('uses locales[0] when defaultLocale is missing', () => {
    expect(resolveI18nConfig({ locales: ['zh', 'en'] })).toEqual({
      locales: ['zh', 'en'],
      defaultLocale: 'zh',
      prefixDefault: undefined,
    });
  });

  it('keeps explicit defaultLocale', () => {
    expect(
      resolveI18nConfig({ locales: ['zh', 'en'], defaultLocale: 'en', prefixDefault: true })
    ).toEqual({
      locales: ['zh', 'en'],
      defaultLocale: 'en',
      prefixDefault: true,
    });
  });

  it('ignores extra fields like endpoint/ttl/load', () => {
    const result = resolveI18nConfig({
      locales: ['zh'],
      defaultLocale: 'zh',
      // simulating extra fields from defineSiteHooks IntlConfig
      ...({ endpoint: '/api/i18n', ttl: 60_000, load: () => null } as unknown as object),
    });
    expect(result).toEqual({
      locales: ['zh'],
      defaultLocale: 'zh',
      prefixDefault: undefined,
    });
  });

  it('handles empty locales array', () => {
    expect(resolveI18nConfig({ locales: [] })).toEqual({
      locales: ['en'],
      defaultLocale: 'en',
      prefixDefault: undefined,
    });
  });
});
