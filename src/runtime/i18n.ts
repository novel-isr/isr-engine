/**
 * i18n 路由工具 —— URL 前缀自动处理（无 React 依赖，server + client 通用）
 *
 * 业务侧用法：
 *
 *   import { parseLocale, withLocale, negotiateLocale } from '@novel-isr/engine/runtime';
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
      pathname: rest === '/' ? '/' : rest.replace(/\/+$/, ''),
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
 * Accept-Language 协商 —— RFC 4647 lookup
 *
 * negotiateLocale('zh-CN,en;q=0.9', { locales: ['zh','en'], defaultLocale: 'en' })
 *   → 'zh'   （'zh-CN' 命中 'zh'）
 *
 * negotiateLocale(null, ...) → defaultLocale
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  config: I18nConfig
): string {
  if (!acceptLanguage) return config.defaultLocale;
  const ranked = acceptLanguage
    .split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find(p => p.startsWith('q='));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q);

  const supported = config.locales.map(l => l.toLowerCase());
  for (const { tag } of ranked) {
    // 精确匹配（'zh' === 'zh'）
    const exact = supported.indexOf(tag);
    if (exact >= 0) return config.locales[exact];
    // 主语言匹配（'zh-CN' → 'zh'）
    const primary = tag.split('-')[0];
    const sub = supported.indexOf(primary);
    if (sub >= 0) return config.locales[sub];
  }
  return config.defaultLocale;
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
