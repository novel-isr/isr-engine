/**
 * defineSiteHooks —— 高阶 FaaS hooks 工厂（声明式配置 → 完整 ServerEntryHooks）
 *
 * 让用户的 src/entry.server.tsx 收紧到「一个 export default + 一个声明式对象」。
 * 内部固化：
 *   - i18n 字典缓存（createCachedFetcher: TTL/SWR/dedup/fallback）
 *   - SEO 路由表 pattern → resolver
 *   - locale 检测（cookie → Accept-Language → 默认）
 *   - 错误打印 / Sentry adapter 透传
 *
 * 用户态写法（最小）：
 *   import { defineSiteHooks } from '@novel-isr/engine';
 *
 *   export default defineSiteHooks({
 *     api: process.env.API_URL!,
 *     site: process.env.SEO_BASE_URL!,
 *     intl: { endpoint: '/api/i18n?locale={locale}' },
 *     seo: {
 *       '/': { title: 'Home', description: '...' },
 *       '/books/:id': { endpoint: '/api/books/{id}', transform: book => ({ title: book.data.title, ... }) },
 *     },
 *   });
 */
import { createCachedFetcher } from './createCachedFetcher';
import type { IntlPayload, PageSeoMeta } from './seo-runtime';

export interface IntlConfig {
  // ─── URL 路由层（被 parseLocale / withLocale 等消费）───────────
  /** 支持的 locale 列表，如 ['zh', 'en']；用于 URL 前缀解析 */
  locales?: readonly string[];
  /** 默认 locale —— 必须在 locales 内；同时作为 detect 失败的兜底（替代旧字段 `fallback`） */
  defaultLocale?: string;
  /** 默认 locale 是否带 URL 前缀（默认 false：'/about'；true：'/zh/about'） */
  prefixDefault?: boolean;

  // ─── 翻译消息加载层（被 SEO/Header 等消费）─────────────────────
  /** 远程 endpoint；`{locale}` 占位符自动替换 */
  endpoint?: string;
  /** 远端响应适配器；支持 admin manifest / SaaS CMS 等非标准响应 */
  transform?: (
    data: unknown,
    locale: string
  ) => IntlPayload | null | undefined | Promise<IntlPayload | null | undefined>;
  /** 本地或自定义加载器；与 endpoint 互斥（优先级更高） */
  load?: (locale: string) => Promise<IntlPayload | null>;
  /** locale 检测（默认：cookie `locale` → Accept-Language 前缀 → defaultLocale） */
  detect?: (req: Request) => string;
  /** 缓存 TTL 毫秒，默认 60_000 */
  ttl?: number;
}

/** 仅静态值，无远程拉取（PageSeoMeta 直接复用，无需扩展） */
export type SeoStaticEntry = PageSeoMeta;

export interface SeoRemoteEntry<T = unknown> {
  /** 远程 endpoint；`{paramName}` 占位符自动替换为路由捕获组 */
  endpoint: string;
  /** 把远程响应转成 PageSeoMeta */
  transform: (data: T, params: Record<string, string>) => PageSeoMeta | null;
  /** 缓存 TTL 毫秒，默认 300_000（5 分钟） */
  ttl?: number;
}

export interface SeoLocalEntry {
  /** 本地加载器：dynamic import / fs.readFile / 内存 Map 都可 */
  load: (params: Record<string, string>) => Promise<PageSeoMeta | null> | PageSeoMeta | null;
  /** 缓存 TTL 毫秒，默认 300_000 */
  ttl?: number;
}

export type SeoEntry = SeoStaticEntry | SeoRemoteEntry | SeoLocalEntry;

export interface RedisConfig {
  /** 优先级最高：完整 URL（redis://[:pass@]host:port/db） */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  /** 默认 'isr:' */
  keyPrefix?: string;
  /** 跨 pod revalidate 广播频道；默认 `${keyPrefix}invalidate` */
  invalidationChannel?: string;
}

export interface SentryConfig {
  /** Sentry DSN（同 Sentry.init 的 dsn）*/
  dsn: string;
  /** 采样率 0-1，默认 0.1 */
  tracesSampleRate?: number;
  environment?: string;
}

export interface ExperimentEntry {
  variants: readonly string[];
  weights?: readonly number[];
}

export interface SiteHooksConfig {
  /**
   * API 基地址（用于 intl + seo 远程 endpoint 的前缀）
   * 同时自动加入 CSP connect-src（让浏览器 CSR-fallback 模式能 fetch）
   */
  api?: string;
  /** 站点根 URL（用于 canonical / og:image 默认前缀） */
  site?: string;
  /** i18n 配置 */
  intl?: IntlConfig;
  /**
   * A/B 实验定义（cookie-sticky；engine 自动挂中间件）
   * Server Component 用 `import { getVariant } from '@novel-isr/engine'` 读取
   */
  experiments?: Record<string, ExperimentEntry>;
  /**
   * 限流（per-IP token bucket）—— 不传则不限流
   */
  rateLimit?: { windowMs?: number; max?: number };
  /** SEO 路由表：path pattern（支持 `:param`）→ 静态 meta 或 remote loader */
  seo?: Record<string, SeoEntry | (() => Promise<PageSeoMeta | null> | PageSeoMeta | null)>;
  /**
   * Redis 配置 —— FaaS 层显式配置（优先级 > REDIS_URL 环境变量）
   * 不传 → 看 env REDIS_URL/REDIS_HOST → 都没 → memory backend
   */
  redis?: RedisConfig;
  /**
   * Sentry 配置 —— FaaS 层显式配置（优先级 > SENTRY_DSN 环境变量）
   * 不传 → 看 env SENTRY_DSN → 都没 → 默认 console 上报
   */
  sentry?: SentryConfig;
  /** 错误回调（默认 console.error 或 sentry.captureException）；自定义时覆盖 */
  onError?: (err: unknown, req: Request, ctx: { traceId: string; locale?: string }) => void;
  /** 请求级 ctx 扩展（除 baseline + locale 之外的业务字段） */
  beforeRequest?: (req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

interface CompiledRoute {
  re: RegExp;
  paramNames: string[];
  resolver: (params: Record<string, string>) => Promise<PageSeoMeta | null> | PageSeoMeta | null;
}

/** 把 `/books/:id/reviews/:rid` 编译成 RegExp + 参数名列表 */
function compilePattern(pattern: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const wildcard = pattern.endsWith('/*');
  const base = wildcard ? pattern.slice(0, -2) : pattern;
  const escaped = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const reSrc = escaped.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${reSrc}${wildcard ? '(?:/.*)?' : ''}$`), paramNames };
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

export interface ServerHooksOutput {
  /** site URL —— SEO 注入时把 image/canonical 等相对路径解析为绝对 URL */
  siteBaseUrl?: string;
  /** 浏览器可访问的 API base —— 注入到 csr-shell 的 window.__API_BASE__ */
  apiBaseUrl?: string;
  /**
   * 原始 intl 配置（用户在 defineSiteHooks 里写的那份），透传出来给 app.tsx 的 parseLocale 用
   * —— 让 i18n 配置只声明一次，不需要单独 i18n.config.ts
   */
  intl?: IntlConfig;
  beforeRequest: (
    req: Request,
    baseline: { traceId: string; startedAt: number }
  ) => Promise<Record<string, unknown>>;
  loadIntl: (req: Request) => Promise<IntlPayload | null>;
  loadSeoMeta: (req: Request) => Promise<PageSeoMeta | null>;
  onError: (err: unknown, req: Request, ctx: { traceId: string; locale?: string }) => void;
  /**
   * 引擎读取的「基础设施配置」—— 不是 hook，是声明
   * cli/start.ts 起 server 时会读这两个字段：
   *   - redis: 优先级高于 REDIS_URL 环境变量，传了就用 Hybrid (L1+L2) 后端
   *   - sentry: 优先级高于 SENTRY_DSN，传了就 init Sentry 并自动接 onError
   */
  __engineConfig?: {
    redis?: RedisConfig;
    sentry?: SentryConfig;
    /** API origin 用于 CSP connect-src 自动放行（FaaS api 字段派生） */
    apiOrigin?: string;
    /** site URL 用于 SEO 注入时解析相对路径（og:image / canonical 必须绝对） */
    siteBaseUrl?: string;
    /** A/B 实验 —— start.ts 据此挂 ABVariantMiddleware */
    experiments?: Record<string, ExperimentEntry>;
    /** 限流 —— start.ts 据此挂 RateLimiter */
    rateLimit?: { windowMs?: number; max?: number };
  };
}

export function defineSiteHooks(config: SiteHooksConfig): ServerHooksOutput {
  const api = config.api ?? '';
  const site = config.site ?? '';
  const fetchJson = async (path: string): Promise<unknown> => {
    try {
      const r = await fetch(api + path);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  // ─── i18n 缓存（一次创建，请求级复用）──────────────
  const intlCfg = config.intl ?? {};
  const fallbackLocale = intlCfg.defaultLocale ?? 'zh-CN';
  const supportedLocales = intlCfg.locales?.length ? intlCfg.locales : undefined;
  const detectLocale =
    intlCfg.detect ??
    ((req: Request): string => {
      const cookie = req.headers.get('cookie')?.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
      if (cookie) {
        const decoded = decodeURIComponent(cookie);
        return supportedLocales
          ? normalizeLocale(decoded, supportedLocales, fallbackLocale)
          : decoded;
      }
      const accept = req.headers.get('accept-language') ?? '';
      return supportedLocales
        ? normalizeLocale(parseAcceptLanguage(accept), supportedLocales, fallbackLocale)
        : inferLocaleFromAcceptLanguage(accept, fallbackLocale);
    });

  const intlLoader = createCachedFetcher<string, IntlPayload>({
    key: locale => `intl:${locale}`,
    ttl: intlCfg.ttl ?? 60_000,
    swr: true,
    fetch: async locale => {
      if (intlCfg.load) {
        const r = await intlCfg.load(locale);
        return r ?? { locale, messages: {}, direction: rtlOf(locale) };
      }
      if (intlCfg.endpoint) {
        const url = fillTemplate(intlCfg.endpoint, { locale });
        const json = await fetchJson(url);
        if (json !== null && intlCfg.transform) {
          const transformed = await intlCfg.transform(json, locale);
          if (transformed) {
            return {
              ...transformed,
              direction: transformed.direction ?? rtlOf(transformed.locale),
            };
          }
        }
        return {
          locale,
          messages: extractIntlMessages(json),
          direction: rtlOf(locale),
        };
      }
      return { locale, messages: {}, direction: rtlOf(locale) };
    },
    fallback: locale => ({ locale, messages: {}, direction: rtlOf(locale) }),
  });

  // ─── SEO 路由表编译 + 远程 loader 缓存（每个 pattern 一份）─────
  const seoRoutes: CompiledRoute[] = [];
  const remoteCaches = new Map<
    string,
    ReturnType<typeof createCachedFetcher<string, PageSeoMeta | null>>
  >();

  for (const [pattern, value] of Object.entries(config.seo ?? {})) {
    const { re, paramNames } = compilePattern(pattern);

    if (typeof value === 'function') {
      // 自定义 resolver
      seoRoutes.push({ re, paramNames, resolver: value as CompiledRoute['resolver'] });
      continue;
    }
    if ('endpoint' in value && typeof (value as SeoRemoteEntry).endpoint === 'string') {
      const remote = value as SeoRemoteEntry;
      const cache = createCachedFetcher<string, PageSeoMeta | null>({
        key: paramKey => `seo:${pattern}:${paramKey}`,
        ttl: remote.ttl ?? 300_000,
        fetch: async paramKey => {
          const params = JSON.parse(paramKey) as Record<string, string>;
          const data = await fetchJson(fillTemplate(remote.endpoint, params));
          if (data === null) return null;
          return remote.transform(data, params);
        },
        fallback: () => null,
      });
      remoteCaches.set(pattern, cache);
      seoRoutes.push({
        re,
        paramNames,
        resolver: params => cache(JSON.stringify(params)),
      });
      continue;
    }
    if ('load' in value && typeof (value as SeoLocalEntry).load === 'function') {
      const local = value as SeoLocalEntry;
      const cache = createCachedFetcher<string, PageSeoMeta | null>({
        key: paramKey => `seo-local:${pattern}:${paramKey}`,
        ttl: local.ttl ?? 300_000,
        fetch: async paramKey => {
          const params = JSON.parse(paramKey) as Record<string, string>;
          return await local.load(params);
        },
        fallback: () => null,
      });
      remoteCaches.set(pattern, cache);
      seoRoutes.push({
        re,
        paramNames,
        resolver: params => cache(JSON.stringify(params)),
      });
      continue;
    }
    // 静态 meta
    const staticMeta = value as SeoStaticEntry;
    const withDefaults: PageSeoMeta = {
      ...staticMeta,
      canonical:
        staticMeta.canonical ??
        (site && pattern && pattern !== '/*' ? `${site}${pattern}` : staticMeta.canonical),
    };
    seoRoutes.push({ re, paramNames, resolver: () => withDefaults });
  }

  // ─── onError ─────
  const onError =
    config.onError ??
    ((err: unknown, req: Request, ctx: { traceId: string }) => {
      console.error('[onError]', {
        traceId: ctx.traceId,
        url: req.url,
        msg: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    siteBaseUrl: site || undefined,
    apiBaseUrl: api || undefined,
    intl: config.intl,
    async beforeRequest(req, _baseline) {
      const locale = detectLocale(req);
      const userExt = config.beforeRequest ? await config.beforeRequest(req) : {};
      return { locale, ...userExt };
    },
    async loadIntl(req) {
      return intlLoader(detectLocale(req));
    },
    async loadSeoMeta(req) {
      const path = new URL(req.url).pathname;
      for (const { re, paramNames, resolver } of seoRoutes) {
        const m = path.match(re);
        if (m) {
          const params: Record<string, string> = { pathname: path };
          paramNames.forEach((n, i) => (params[n] = m[i + 1] ?? ''));
          return await resolver(params);
        }
      }
      return null;
    },
    onError,
    __engineConfig: {
      redis: config.redis,
      sentry: config.sentry,
      apiOrigin: config.api ? safeOrigin(config.api) : undefined,
      siteBaseUrl: site || undefined,
      experiments: config.experiments,
      rateLimit: config.rateLimit,
    },
  };
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function rtlOf(locale: string): 'ltr' | 'rtl' {
  return /^(ar|he|fa|ur)/.test(locale) ? 'rtl' : 'ltr';
}

function parseAcceptLanguage(accept: string): string {
  let best = '';
  let bestQ = -1;
  for (const part of accept.split(',')) {
    const [rawLocale, ...attrs] = part.trim().split(';');
    if (!rawLocale) continue;
    const qAttr = attrs.find(attr => attr.trim().startsWith('q='));
    const q = qAttr ? Number(qAttr.trim().slice(2)) : 1;
    if (Number.isFinite(q) && q > bestQ) {
      best = rawLocale;
      bestQ = q;
    }
  }
  return best;
}

function inferLocaleFromAcceptLanguage(accept: string, fallbackLocale: string): string {
  const best = parseAcceptLanguage(accept);
  if (!best) return fallbackLocale;
  const primary = best.toLowerCase().split('-')[0];
  if (primary === 'zh') return 'zh-CN';
  if (primary === 'en') return 'en';
  return fallbackLocale;
}

function normalizeLocale(
  value: string,
  supportedLocales: readonly string[],
  fallbackLocale: string
): string {
  const lower = value.toLowerCase();
  const exact = supportedLocales.find(locale => locale.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = lower.split('-')[0];
  const byPrefix = supportedLocales.find(locale => locale.toLowerCase().split('-')[0] === prefix);
  return byPrefix ?? fallbackLocale;
}

function extractIntlMessages(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const raw = data as Record<string, unknown>;
  const candidate = raw.data ?? raw.messages ?? raw.strings;
  if (!candidate || typeof candidate !== 'object') return {};
  if (raw.strings === candidate || isFlatRecord(candidate)) {
    return expandDottedRecord(candidate as Record<string, unknown>);
  }
  return candidate as Record<string, unknown>;
}

function isFlatRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value as Record<string, unknown>).some(key => key.includes('.'));
}

function expandDottedRecord(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let cur = out;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        cur[part] = value;
        return;
      }
      const next = cur[part];
      if (!next || typeof next !== 'object') cur[part] = {};
      cur = cur[part] as Record<string, unknown>;
    });
  }
  return out;
}
