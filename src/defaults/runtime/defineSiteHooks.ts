/**
 * defineSiteHooks —— 高阶 FaaS hooks 工厂（声明式配置 → 完整 ServerEntryHooks）
 *
 * 让用户的 src/entry.server.tsx 收紧到「一个 export default + 一个声明式对象」。
 * 部署/平台配置（api/site/redis/sentry/rateLimit/experiments）放 ssr.config.ts
 * 的 runtime 字段；entry.server.tsx 只保留请求期 hooks 和 loader。
 * 内部固化：
 *   - i18n 字典缓存（createCachedFetcher: TTL/SWR/dedup/fallback）
 *   - SEO 路由表 pattern → resolver
 *   - locale 检测（cookie → Accept-Language → 默认）
 *   - 错误打印 / Sentry adapter 透传
 *
 * 用户态写法（商业项目推荐）：
 *   import {
 *     createAdminIntlLoader,
 *     createAdminSeoLoader,
 *     defineSiteHooks,
 *   } from '@novel-isr/engine/site-hooks';
 *   import baseline from './config/site-baseline.json';
 *
 *   export default defineSiteHooks({
 *     intl: {
 *       locales: baseline.site.locales,
 *       defaultLocale: baseline.site.defaultLocale,
 *       load: createAdminIntlLoader({
 *         fallbackMessages: baseline.i18n.strings,
 *         defaultLocale: baseline.site.defaultLocale,
 *       }),
 *       ttl: 60_000,
 *     },
 *     seo: {
 *       '/*': {
 *         load: createAdminSeoLoader({ fallbackEntries: baseline.seo.entries }),
 *         ttl: 60_000,
 *       },
 *     },
 *   });
 */
import { createCachedFetcher } from './createCachedFetcher';
import type { IntlPayload, PageSeoMeta } from './seo-runtime';
import type { ISRConfig } from '../../types';

export type SiteRuntimeConfig = NonNullable<ISRConfig['runtime']>;

export interface SiteRuntimeContext {
  runtime: SiteRuntimeConfig;
  api?: string;
  site?: string;
}

export type AdminApiBase = string | ((ctx: SiteRuntimeContext) => string | null | undefined);

export type IntlMessagesByLocale = Record<string, Record<string, unknown>>;

export interface CreateAdminIntlLoaderOptions {
  /** 远端字典端点；相对路径会用 runtime.api 或 apiBaseUrl 拼接 */
  endpoint?: string;
  /** 显式覆盖远端 API base；不传时使用 ssr.config.ts runtime.api */
  apiBaseUrl?: AdminApiBase;
  /** 本地兜底字典，通常来自业务自己的 site-baseline.json */
  fallbackMessages?: IntlMessagesByLocale;
  /** 远端和本地都无法命中时使用的 locale */
  defaultLocale?: string;
  /** 远端请求超时，默认 1200ms */
  timeoutMs?: number;
  /** 响应头 / dev inspector 里显示的远端来源名 */
  remoteSource?: string;
  /** 响应头 / dev inspector 里显示的 fallback 来源名 */
  fallbackSource?: string;
}

export interface AdminSeoFallbackEntry extends PageSeoMeta {
  path: string;
  group?: string;
}

export interface CreateAdminSeoLoaderOptions {
  /** 远端 SEO 端点；支持 {pathname} 和路由 params 占位符 */
  endpoint?: string;
  /** 显式覆盖远端 API base；不传时使用 ssr.config.ts runtime.api */
  apiBaseUrl?: AdminApiBase;
  /** 本地兜底 SEO 条目，通常来自业务自己的 site-baseline.json */
  fallbackEntries?: readonly AdminSeoFallbackEntry[];
  /** 远端请求超时，默认 1200ms */
  timeoutMs?: number;
}

export interface IntlConfig {
  // ─── URL 路由层（被 parseLocale / withLocale 等消费）───────────
  /** 支持的 locale 列表，如 ['zh', 'en']；用于 URL 前缀解析 */
  locales?: readonly string[];
  /** 默认 locale —— 必须在 locales 内；同时作为 detect 失败的兜底 */
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
  load?: (locale: string, ctx: SiteRuntimeContext) => Promise<IntlPayload | null>;
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
  load: (
    params: Record<string, string>,
    ctx: SiteRuntimeContext
  ) => Promise<PageSeoMeta | null> | PageSeoMeta | null;
  /** 缓存 TTL 毫秒，默认 300_000 */
  ttl?: number;
}

export type SeoEntry = SeoStaticEntry | SeoRemoteEntry | SeoLocalEntry;

export interface SiteHooksConfig {
  /** i18n 配置 */
  intl?: IntlConfig;
  /** SEO 路由表：path pattern（支持 `:param`）→ 静态 meta 或 remote loader */
  seo?: Record<string, SeoEntry | (() => Promise<PageSeoMeta | null> | PageSeoMeta | null)>;
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

export function createAdminIntlLoader(
  options: CreateAdminIntlLoaderOptions = {}
): NonNullable<IntlConfig['load']> {
  const endpoint = options.endpoint ?? '/api/i18n/{locale}/manifest';
  const fallbackMessages = options.fallbackMessages ?? {};
  const defaultLocale = options.defaultLocale;
  const supportedLocales = Object.keys(fallbackMessages);

  return async (locale, ctx) => {
    const normalizedLocale =
      supportedLocales.length && defaultLocale
        ? normalizeLocale(locale, supportedLocales, defaultLocale)
        : locale;
    const remoteUrl = resolveAdminUrl(endpoint, { locale: normalizedLocale }, ctx, options);
    const remote = remoteUrl
      ? await fetchJsonWithTimeout<unknown>(remoteUrl, options.timeoutMs)
      : null;
    const remoteMessages = extractIntlMessagesOrNull(remote);
    const localMessages =
      fallbackMessages[normalizedLocale] ??
      (defaultLocale ? fallbackMessages[defaultLocale] : undefined) ??
      {};
    const messages = remoteMessages ?? normalizeMessages(localMessages);

    return {
      locale: normalizedLocale,
      messages,
      direction: rtlOf(normalizedLocale),
      source: remoteMessages
        ? (options.remoteSource ?? 'admin')
        : (options.fallbackSource ?? 'local-fallback'),
    };
  };
}

export function createAdminSeoLoader(
  options: CreateAdminSeoLoaderOptions = {}
): SeoLocalEntry['load'] {
  const endpoint = options.endpoint ?? '/api/seo?path={pathname}';
  const fallbackEntries = options.fallbackEntries ?? [];

  return async (params, ctx) => {
    const pathname = normalizePathname(params.pathname || '/');
    const remoteUrl = resolveAdminUrl(endpoint, { ...params, pathname }, ctx, options);
    const remote = remoteUrl
      ? await fetchJsonWithTimeout<unknown>(remoteUrl, options.timeoutMs)
      : null;
    const remoteMeta = extractSeoMetaOrNull(remote);
    if (remoteMeta) return remoteMeta;

    const fallback = fallbackEntries.find(entry => normalizePathname(entry.path) === pathname);
    if (!fallback) return null;
    const meta = { ...fallback } as Record<string, unknown>;
    delete meta.path;
    delete meta.group;
    return meta as PageSeoMeta;
  };
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
  __configureRuntime?: (runtime: SiteRuntimeConfig) => ServerHooksOutput;
}

export function defineSiteHooks(config: SiteHooksConfig): ServerHooksOutput {
  return createSiteHooks(config, {});
}

export function applyRuntimeToServerHooks<T extends object>(
  hooks: T,
  runtime: SiteRuntimeConfig
): T {
  const maybeRuntimeAware = hooks as T & {
    __configureRuntime?: (runtime: SiteRuntimeConfig) => T;
  };
  if (typeof maybeRuntimeAware.__configureRuntime === 'function') {
    return maybeRuntimeAware.__configureRuntime(runtime);
  }
  const baseHooks = hooks as T & {
    siteBaseUrl?: string;
    apiBaseUrl?: string;
  };
  return {
    ...hooks,
    siteBaseUrl: baseHooks.siteBaseUrl ?? runtime.site,
    apiBaseUrl: baseHooks.apiBaseUrl ?? runtime.api,
  } as T;
}

function createSiteHooks(config: SiteHooksConfig, runtime: SiteRuntimeConfig): ServerHooksOutput {
  const api = runtime.api ?? '';
  const site = runtime.site ?? '';
  const runtimeCtx: SiteRuntimeContext = {
    runtime,
    api: api || undefined,
    site: site || undefined,
  };
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
        const r = await intlCfg.load(locale, runtimeCtx);
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
          return await local.load(params, runtimeCtx);
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

  const output: ServerHooksOutput = {
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
  };
  Object.defineProperty(output, '__configureRuntime', {
    enumerable: false,
    value: (nextRuntime: SiteRuntimeConfig) => createSiteHooks(config, nextRuntime),
  });
  return output;
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
  return extractIntlMessagesOrNull(data) ?? {};
}

function extractIntlMessagesOrNull(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const dataValue = raw.data;
  const candidate =
    raw.strings ??
    raw.messages ??
    (isRecord(dataValue) && 'strings' in dataValue ? dataValue.strings : dataValue);
  if (!candidate || typeof candidate !== 'object') return null;
  return normalizeMessages(candidate as Record<string, unknown>);
}

function normalizeMessages(messages: Record<string, unknown>): Record<string, unknown> {
  if (isFlatRecord(messages)) {
    return expandDottedRecord(messages);
  }
  return messages;
}

function extractSeoMetaOrNull(data: unknown): PageSeoMeta | null {
  if (!isRecord(data)) return null;
  const candidate = 'data' in data ? data.data : data;
  if (!isRecord(candidate)) return null;
  return candidate as PageSeoMeta;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 1200): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function resolveAdminUrl(
  endpoint: string,
  vars: Record<string, string>,
  ctx: SiteRuntimeContext,
  options: { apiBaseUrl?: AdminApiBase }
): string | null {
  const filled = fillTemplate(endpoint, vars);
  if (/^(https?:)?\/\//i.test(filled)) return filled;
  const apiBase = resolveAdminApiBase(ctx, options.apiBaseUrl);
  if (!apiBase) return null;
  return `${apiBase.replace(/\/+$/, '')}/${filled.replace(/^\/+/, '')}`;
}

function resolveAdminApiBase(ctx: SiteRuntimeContext, apiBaseUrl?: AdminApiBase): string | null {
  if (typeof apiBaseUrl === 'function') {
    return apiBaseUrl(ctx) ?? null;
  }
  return apiBaseUrl ?? ctx.api ?? null;
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
