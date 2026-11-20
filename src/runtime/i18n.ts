/**
 * i18n 路由工具 —— URL 前缀自动处理（无 React 依赖，server + client 通用）
 *
 * 业务侧用法：
 *
 *   import { parseLocale, withLocale, negotiateLocale } from 'isr-engine/runtime';
 *
 *   const I18N = { locales: ['zh', 'en'] as const, defaultLocale: 'zh' };
 *
 *   // SSR 入口：从 URL 拆 locale + 干净 pathname 给路由
 *   const { locale, pathname } = parseLocale(url.pathname, I18N);
 *   return <Layout lang={locale}>{resolveRoute({ pathname, locale })}</Layout>;
 *
 *   // Header 切换语言
 *   const href = withLocale('/books/1', 'en', I18N);    // → '/en/books/1'
 *   const href = withLocale('/books/1', 'zh', I18N);    // → '/books/1'（默认 locale 不前缀）
 *
 *   // 服务器协商：Accept-Language 头 → locale
 *   const locale = negotiateLocale(req.headers.get('accept-language'), I18N);
 *
 * 设计取舍：
 *   - 默认 locale 不带前缀（'/about'），其他 locale 带（'/en/about'）
 *     → 与 Next.js i18n routing 默认 + Vue I18n 一致；SEO 友好（默认语言 URL 简洁）
 *   - 用 `prefixDefault: true` 切到"全部带前缀"模式（如 '/zh/about'）
 *   - 不内置消息字典 / 翻译机制 —— 那是 react-intl / FormatJS / lingui 的活
 */

import { trimTrailingSlashes } from '../utils/trimTrailingSlashes';
export interface I18nConfig {
  /** 支持的 locale 列表，如 ['zh', 'en', 'ja'] */
  locales: readonly string[];
  /** 默认 locale —— 必须在 locales 内 */
  defaultLocale: string;
  /** 是否给默认 locale 也加 URL 前缀（默认 false：'/about'；true：'/zh/about'） */
  prefixDefault?: boolean;
}

export interface ParsedLocale {
  /** 解析出的 locale（命中 URL 前缀则取前缀，否则取 defaultLocale） */
  locale: string;
  /** 去掉 locale 前缀后的"业务 pathname"，路由表只需匹配这个 */
  pathname: string;
  /** URL 是否真的带了 locale 前缀 */
  hasPrefix: boolean;
}

/**
 * 从 pathname 拆出 locale 与业务 pathname
 *
 * '/zh/books/1' + { locales: ['zh','en'], defaultLocale: 'en' }
 *   → { locale: 'zh', pathname: '/books/1', hasPrefix: true }
 *
 * '/books/1' 同上
 *   → { locale: 'en', pathname: '/books/1', hasPrefix: false }
 */
export function parseLocale(pathname: string, config: I18nConfig): ParsedLocale {
  const segments = pathname.split('/');
  // segments[0] 是空串（leading '/'），segments[1] 才是首段
  const first = segments[1];
  if (first && config.locales.includes(first)) {
    const rest = '/' + segments.slice(2).join('/');
    return {
      locale: first,
      pathname: rest === '/' ? '/' : trimTrailingSlashes(rest),
      hasPrefix: true,
    };
  }
  return { locale: config.defaultLocale, pathname: pathname || '/', hasPrefix: false };
}

/**
 * 给业务 pathname 套上 locale 前缀（生成可跳转 URL）
 *
 * withLocale('/about', 'en', { defaultLocale: 'zh', locales: ['zh','en'] })
 *   → '/en/about'
 *
 * withLocale('/about', 'zh', { defaultLocale: 'zh', locales: ['zh','en'] })
 *   → '/about'  （默认 locale 不前缀）
 *
 * withLocale('/about', 'zh', { ..., prefixDefault: true })
 *   → '/zh/about'
 */
export function withLocale(pathname: string, locale: string, config: I18nConfig): string {
  if (!config.locales.includes(locale)) {
    throw new Error(`[i18n] unknown locale "${locale}"; allowed: ${config.locales.join(', ')}`);
  }
  const clean = pathname.startsWith('/') ? pathname : '/' + pathname;
  if (locale === config.defaultLocale && !config.prefixDefault) return clean;
  return `/${locale}${clean === '/' ? '' : clean}`;
}

/**
 * 按权重协商 Accept-Language（支持主语言回退和通配符）
 *
 * negotiateLocale('zh-CN,en;q=0.9', { locales: ['zh','en'], defaultLocale: 'en' })
 *   → 'zh'   （'zh-CN' 命中 'zh'）
 *
 * negotiateLocale('en-GB', { locales: ['zh-hans','en-us'], defaultLocale: 'zh-hans' })
 *   → 'en-us'   （'en-GB' 主语言 'en' 回退到第一个 en-*）
 *
 * negotiateLocale(null, ...) → defaultLocale
 *
 * @throws {RangeError} When the header explicitly rejects every available locale.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  config: I18nConfig
): string {
  const locale = selectAcceptableLocale(acceptLanguage, config);
  if (locale !== null) return locale;
  const error = new RangeError('[i18n] no supported locale is acceptable');
  Object.defineProperty(error, NO_ACCEPTABLE_LOCALE, { value: true });
  throw error;
}

// The server entry and SiteHooks can load separately bundled copies of this module.
const NO_ACCEPTABLE_LOCALE = Symbol.for('isr-engine.no-acceptable-locale');

export function isNoAcceptableLocaleError(error: unknown): boolean {
  return error instanceof RangeError && NO_ACCEPTABLE_LOCALE in error;
}

/** Returns null when the header explicitly rejects every available locale. */
export function selectAcceptableLocale(
  acceptLanguage: string | null | undefined,
  config: I18nConfig
): string | null {
  if (!acceptLanguage) return config.defaultLocale;
  const ranked = acceptLanguage
    .split(',')
    .flatMap(part => {
      const [rawTag, ...params] = part.split(';');
      const tag = rawTag.trim().toLowerCase();
      const weight = params
        .map(param => param.trim())
        .find(param => /^q=/i.test(param))
        ?.slice(2)
        .trim();
      const q = weight === undefined ? 1 : Number(weight);
      return tag && weight !== '' && q >= 0 && q <= 1 ? [{ tag, q }] : [];
    })
    .sort((a, b) => b.q - a.q);

  // Apply the most specific range to each available tag before lookup or fallback.
  const bySpecificity = [...ranked].sort(
    (a, b) => rangeSpecificity(b.tag) - rangeSpecificity(a.tag) || a.q - b.q
  );
  const matchingRange = (locale: string) =>
    bySpecificity.find(({ tag }) => tag === '*' || locale === tag || locale.startsWith(tag + '-'));
  const defaultRange = matchingRange(config.defaultLocale.toLowerCase());
  const supported = config.locales
    .map(locale => {
      const tag = locale.toLowerCase();
      return { locale, tag, range: matchingRange(tag) };
    })
    .filter(({ range }) => range?.q !== 0);

  for (const { tag, q } of ranked) {
    if (q === 0) continue;
    if (tag === '*') {
      if (defaultRange?.tag === '*' && defaultRange.q > 0) return config.defaultLocale;
      const match = supported.find(locale => locale.range?.tag === '*');
      if (match) return match.locale;
      continue;
    }
    const primary = tag.split('-')[0];
    const match =
      supported.find(locale => locale.tag === tag) ??
      supported.find(locale => locale.tag === primary) ??
      supported.find(locale => locale.tag.startsWith(primary + '-'));
    if (match) return match.locale;
  }

  return defaultRange?.q === 0 ? (supported[0]?.locale ?? null) : config.defaultLocale;
}

function rangeSpecificity(tag: string): number {
  return tag === '*' ? 0 : tag.length;
}

/**
 * 列出某业务 pathname 在所有 locale 下的 URL —— 用于 <link rel="alternate" hreflang>
 *
 * alternates('/about', { locales: ['zh','en'], defaultLocale: 'zh' })
 *   → [{ hreflang: 'zh', href: '/about' }, { hreflang: 'en', href: '/en/about' }]
 */
export function alternates(
  pathname: string,
  config: I18nConfig
): Array<{ hreflang: string; href: string }> {
  return config.locales.map(locale => ({
    hreflang: locale,
    href: withLocale(pathname, locale, config),
  }));
}

/**
 * 从 SiteHooks 的 intl 字段提取 URL 路由配置并填默认值
 *
 * 用途：消除消费者侧 `app.tsx` 里那段「从 siteHooks.intl 抠出 locales/defaultLocale/prefixDefault
 * 再补默认值组装 I18nConfig」的重复样板。
 *
 *   // before
 *   const intl = siteHooks.intl ?? {};
 *   const I18N: I18nConfig = {
 *     locales: intl.locales ?? ['en'],
 *     defaultLocale: intl.defaultLocale ?? 'en',
 *     prefixDefault: intl.prefixDefault,
 *   };
 *
 *   // after
 *   const I18N = resolveI18nConfig(siteHooks.intl);
 *
 * 行为：
 *   - 缺省 → `{ locales: ['en'], defaultLocale: 'en' }`（单语言英文兜底）
 *   - locales 给了但 defaultLocale 没给 → 取 locales[0]
 *   - 多余字段（endpoint / load / ttl / detect）忽略，只挑 URL 路由相关
 */
export function resolveI18nConfig(
  intl?: {
    locales?: readonly string[];
    defaultLocale?: string;
    prefixDefault?: boolean;
  } | null
): I18nConfig {
  const locales = intl?.locales && intl.locales.length > 0 ? intl.locales : ['en'];
  const defaultLocale = intl?.defaultLocale ?? locales[0];
  return {
    locales,
    defaultLocale,
    prefixDefault: intl?.prefixDefault,
  };
}
