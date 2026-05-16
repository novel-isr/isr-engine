/**
 * defineSiteHooks —— 高阶 FaaS hooks 工厂（声明式配置 → 完整 ServerEntryHooks）
 *
 * 让用户的 src/entry.server.tsx 收紧到「只写请求期 hooks」。
 * 部署/平台配置（api/site/redis/experiments/i18n/seo/telemetry）放
 * ssr.config.ts 的 runtime 字段；entry.server.tsx 只保留 beforeRequest / onError。
 * 注：experiments 是 experimentation platform 的通用字段名，业务侧可理解为 A/B testing。
 * 内部固化：
 *   - i18n 字典缓存（createCachedFetcher: TTL/SWR/dedup/fallback）
 *   - SEO 路由表 pattern → resolver
 *   - locale 检测（cookie → Accept-Language → 默认）
 *   - i18n/seo 远端相对 endpoint 统一使用 runtime.services.api
 *   - 服务端渲染错误打印 + runtime.telemetry errors endpoint 上报
 *
 * beforeRequest 的边界：
 *   - 它在每次 HTTP/RSC 请求进入渲染前执行。
 *   - 返回值会合并进 RequestContext，Server Component 用 getRequestContext() 读取。
 *   - 适合放 userId / tenantId / requestSegment 这类请求现场字段。
 *   - 不适合放 Redis、SEO、i18n、A/B 定义、慢 API 或数据库查询。
 *   - A/B variant 由 runtime.experiments + engine middleware 注入，页面用 getVariant()。
 *
 * 用户态写法（商业项目推荐）：
 *   import { defineAdminSiteHooks } from '@novel-isr/engine/site-hooks';
 *
 *   export default defineAdminSiteHooks({
 *     beforeRequest: req => ({
 *       userId: req.headers.get('x-user-id') ?? undefined,
 *       tenantId: req.headers.get('x-tenant-id') ?? 'public',
 *       requestSegment: req.headers.get('x-segment') ?? 'default',
 *     }),
 *   });
 */
import { createCachedFetcher } from './createCachedFetcher';
import type { IntlPayload, PageSeoMeta } from './seo-runtime';
import type {
  DynamicSeoResolver,
  ISRConfig,
  RuntimeI18nConfig,
  RuntimeSeoConfig,
} from '../../types';
import { readCookie } from '../../utils/cookie';
import { parseLocale, type I18nConfig } from '../../runtime/i18n';

export { getCookieHeader, parseCookieHeader, readCookie } from '../../utils/cookie';

export type SiteRuntimeConfig = ISRConfig['runtime'];

export interface SiteRuntimeContext {
  runtime: SiteRuntimeConfig;
  services: RuntimeServices;
  telemetry?: string;
  site?: string;
}

export interface RuntimeServices {
  api?: string;
  telemetry?: string;
}

function createEmptyRuntimeConfig(): SiteRuntimeConfig {
  return {
    site: undefined,
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    telemetry: false,
  };
}

export type RuntimeServiceBase = string | ((ctx: SiteRuntimeContext) => string | null | undefined);

export type IntlMessagesByLocale = Record<string, Record<string, unknown>>;

export interface CreateAdminIntlLoaderOptions {
  /** 远端字典端点；相对路径会用 runtime.services.api 拼接 */
  endpoint?: string;
  /** 本地兜底字典，通常来自 ssr.config.ts runtime.i18n.fallbackLocal */
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
  /** 本地兜底 SEO 条目，通常来自 ssr.config.ts runtime.seo.fallbackLocal */
  fallbackEntries?: readonly AdminSeoFallbackEntry[];
  /** 远端请求超时，默认 1200ms */
  timeoutMs?: number;
  /**
   * 参数化路径解析器；admin endpoint 没命中且 fallback 也没命中时按 pattern 匹配
   * 调一个用户函数。让业务页面零 SEO 代码，所有动态 SEO 集中在 ssr.config.ts。
   */
  dynamicResolvers?: readonly DynamicSeoResolver[];
}

/**
 * 内部用：把 `/books/:id` 这种 pattern 编译成 RegExp + 参数名列表。
 * `:name` 匹配单段（不跨 /）。`*` 匹配任意后缀（包括 /），收成 ":wildcard" param。
 * 编译后缓存，避免每次请求重算。
 */
interface CompiledSeoResolver {
  re: RegExp;
  paramNames: string[];
  resolver: DynamicSeoResolver;
}

function compileSeoResolver(resolver: DynamicSeoResolver): CompiledSeoResolver {
  const paramNames: string[] = [];
  const reSrc = resolver.pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)|\\\*/g, (m, name) => {
      if (m === '\\*') {
        paramNames.push('wildcard');
        return '(.*)';
      }
      paramNames.push(name);
      return '([^/]+)';
    });
  return {
    re: new RegExp(`^${reSrc}$`),
    paramNames,
    resolver,
  };
}

export interface DefineAdminSiteHooksOptions {
  i18n?: {
    locales?: readonly string[];
    defaultLocale?: string;
    endpoint?: string;
    ttl?: number;
    prefixDefault?: boolean;
    detect?: IntlConfig['detect'];
    fallbackLocal?: IntlMessagesByLocale;
    timeoutMs?: number;
    remoteSource?: string;
    fallbackSource?: string;
  };
  seo?: {
    endpoint?: string;
    ttl?: number;
    fallbackLocal?: readonly Record<string, unknown>[];
    timeoutMs?: number;
    /** 参数化路径的 SEO 解析器（参考 RuntimeSeoConfig.dynamicResolvers）。 */
    dynamicResolvers?: readonly DynamicSeoResolver[];
  };
  beforeRequest?: SiteHooksConfig['beforeRequest'];
  onError?: SiteHooksConfig['onError'];
  headExtras?: SiteHooksConfig['headExtras'];
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
  /**
   * 错误回调。平台默认会先执行 console + runtime.telemetry errors endpoint 上报；
   * 自定义 onError 作为业务补充回调追加执行，不会关闭平台默认上报。
   */
  onError?: (
    err: unknown,
    req: Request,
    ctx: { traceId: string; locale?: string }
  ) => void | Promise<void>;
  /**
   * 请求级 ctx 扩展（除 engine 基线字段 + locale 之外的业务字段）。
   *
   * 典型用途：userId、tenantId、requestSegment、审计字段。
   * 返回值会合并进 RequestContext；Server Component 使用
   * `getRequestContext()` 读取，Client Component 需要由 Server Component
   * 作为 props 传入。
   *
   * 注意：
   *   - 这里处在首屏关键路径上，应只做 header/cookie 解析。
   *   - 不要在这里查数据库或慢 API。
   *   - 不要在这里解析 A/B cookie；页面用 `getVariant()`。
   */
  beforeRequest?: (req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * 注入到 `<head>` 末尾（`</head>` 之前）的 raw HTML 字符串。
   *
   * 通过 SSR HTML stream transformer 注入，**完全脱离 React 树** —— 不进 client RSC
   * payload，不触发 React 19 + plugin-rsc 的 head children mismatch hydration 错误。
   *
   * 典型用途：
   *   - 主题 init inline blocking script（避免 FOUC，next-themes 同款）
   *   - GA / GTM snippet
   *   - A/B variant flag injection
   *   - CSP nonce / preload hints
   *
   * 业务侧返回完整的标签 HTML（含 `<script>` / `<style>` / `<meta>` 外壳）。返回
   * 空字符串 / undefined 时跳过注入。
   *
   * ctx.nonce：当前请求的 CSP nonce（engine 自动注入）。业务侧的 inline `<script>`
   * 必须带上 nonce 属性，否则被 nonce-based CSP 阻断：
   *
   * ```ts
   * import { THEME_INIT_SCRIPT } from '@novel-isr/ui/theme-utils';
   *
   * defineAdminSiteHooks({
   *   headExtras: ({ nonce }) =>
   *     `<script${nonce ? ` nonce="${nonce}"` : ''}>${THEME_INIT_SCRIPT}</script>`,
   * });
   * ```
   */
  headExtras?: (ctx: { nonce?: string }) => string | undefined;
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
    const remoteUrl = resolveAdminUrl(endpoint, { locale: normalizedLocale }, ctx);
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
        ? (options.remoteSource ?? 'remote')
        : (options.fallbackSource ?? 'local-fallback'),
    };
  };
}

export function createAdminSeoLoader(
  options: CreateAdminSeoLoaderOptions = {}
): SeoLocalEntry['load'] {
  const endpoint = options.endpoint ?? '/api/seo?path={pathname}';
  const fallbackEntries = options.fallbackEntries ?? [];
  // 编译一次 + 缓存。N 个 resolver 在每个请求里只是 N 次正则 test，cost 可忽略。
  const compiledResolvers: CompiledSeoResolver[] = (options.dynamicResolvers ?? []).map(
    compileSeoResolver
  );

  return async (params, ctx) => {
    const pathname = normalizePathname(params.pathname || '/');

    // 1. admin endpoint —— 运营在 dashboard 给具体 path 配过的覆盖优先级最高
    const remoteUrl = resolveAdminUrl(endpoint, { ...params, pathname }, ctx);
    const remote = remoteUrl
      ? await fetchJsonWithTimeout<unknown>(remoteUrl, options.timeoutMs)
      : null;
    const remoteMeta = extractSeoMetaOrNull(remote);
    if (remoteMeta) return remoteMeta;

    // 2. dynamic resolvers —— 参数化路径的请求期数据驱动
    if (compiledResolvers.length > 0) {
      for (const compiled of compiledResolvers) {
        const m = pathname.match(compiled.re);
        if (!m) continue;
        const resolverParams: Record<string, string> = {};
        compiled.paramNames.forEach((name, i) => {
          resolverParams[name] = m[i + 1] ?? '';
        });
        try {
          const result = await compiled.resolver.resolve({
            pathname,
            params: resolverParams,
            locale: typeof params.locale === 'string' ? params.locale : undefined,
            services: ctx.services,
          });
          if (result) return result as PageSeoMeta;
        } catch (err) {
          // resolver 抛错不阻塞渲染：业务异常时把 SEO 当 null 处理
          console.warn('[seo] dynamic resolver threw, falling through to fallback', err);
        }
        // 同 pattern 没命中数据就继续找下一个 resolver / fallback；不退出。
        // 例：/books/:id 解析失败时，可能匹配了更宽的 /:scope/:id resolver 兜底。
      }
    }

    // 3. fallbackLocal —— build 期冻结的兜底
    const fallback = fallbackEntries.find(entry => normalizePathname(entry.path) === pathname);
    if (!fallback) return null;
    const meta = { ...fallback } as Record<string, unknown>;
    delete meta.path;
    delete meta.group;
    return meta as PageSeoMeta;
  };
}

export function defineAdminSiteHooks(options: DefineAdminSiteHooksOptions = {}): ServerHooksOutput {
  return createAdminSiteHooks(options, createEmptyRuntimeConfig());
}

function createAdminSiteHooks(
  options: DefineAdminSiteHooksOptions,
  runtime: SiteRuntimeConfig
): ServerHooksOutput {
  const runtimeI18n: Partial<RuntimeI18nConfig> = runtime.i18n ?? {};
  const runtimeSeo: Partial<RuntimeSeoConfig> = runtime.seo ?? {};
  const i18n = options.i18n ?? {};
  const seo = options.seo ?? {};
  const fallbackMessages = i18n.fallbackLocal ?? runtimeI18n.fallbackLocal ?? {};
  const locales =
    i18n.locales ??
    runtimeI18n.locales ??
    (Object.keys(fallbackMessages).length > 0 ? Object.keys(fallbackMessages) : ['en']);
  const defaultLocale = i18n.defaultLocale ?? runtimeI18n.defaultLocale ?? locales[0] ?? 'en';

  const output = createSiteHooks(
    {
      beforeRequest: options.beforeRequest,
      onError: options.onError,
      headExtras: options.headExtras,
      intl: {
        locales,
        defaultLocale,
        prefixDefault: i18n.prefixDefault ?? runtimeI18n.prefixDefault,
        detect: i18n.detect,
        load: createAdminIntlLoader({
          endpoint: i18n.endpoint ?? runtimeI18n.endpoint,
          fallbackMessages,
          defaultLocale,
          timeoutMs: i18n.timeoutMs ?? runtimeI18n.timeoutMs,
          remoteSource: i18n.remoteSource ?? runtimeI18n.remoteSource,
          fallbackSource: i18n.fallbackSource ?? runtimeI18n.fallbackSource,
        }),
        ttl: i18n.ttl ?? runtimeI18n.ttl ?? 60_000,
      },
      seo: {
        '/*': {
          load: createAdminSeoLoader({
            endpoint: seo.endpoint ?? runtimeSeo.endpoint,
            fallbackEntries: normalizeAdminSeoFallbackEntries(
              seo.fallbackLocal ?? runtimeSeo.fallbackLocal
            ),
            timeoutMs: seo.timeoutMs ?? runtimeSeo.timeoutMs,
            dynamicResolvers: seo.dynamicResolvers ?? runtimeSeo.dynamicResolvers,
          }),
          ttl: seo.ttl ?? runtimeSeo.ttl ?? 60_000,
        },
      },
    },
    runtime
  );
  Object.defineProperty(output, '__configureRuntime', {
    enumerable: false,
    configurable: true,
    value: (nextRuntime: SiteRuntimeConfig) => createAdminSiteHooks(options, nextRuntime),
  });
  return output;
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
    engineCtx: { traceId: string; startedAt: number }
  ) => Promise<Record<string, unknown>>;
  loadIntl: (req: Request) => Promise<IntlPayload | null>;
  loadSeoMeta: (req: Request) => Promise<PageSeoMeta | null>;
  onError: (
    err: unknown,
    req: Request,
    ctx: { traceId: string; locale?: string }
  ) => void | Promise<void>;
  /** 注入 `<head>` 末尾的 raw HTML —— 详见 SiteHooksConfig.headExtras 注释 */
  headExtras?: (ctx: { nonce?: string }) => string | undefined;
  __configureRuntime?: (runtime: SiteRuntimeConfig) => ServerHooksOutput;
}

export function defineSiteHooks(config: SiteHooksConfig): ServerHooksOutput {
  return createSiteHooks(config, createEmptyRuntimeConfig());
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
    intl?: unknown;
    loadIntl?: unknown;
    loadSeoMeta?: unknown;
    beforeRequest?: SiteHooksConfig['beforeRequest'];
    onError?: SiteHooksConfig['onError'];
  };
  const services = resolveRuntimeServices(runtime);
  const siteBaseUrl = baseHooks.siteBaseUrl ?? runtime.site;
  const apiBaseUrl = baseHooks.apiBaseUrl ?? services.api;
  const hasUserContentHooks =
    !!baseHooks.intl ||
    typeof baseHooks.loadIntl === 'function' ||
    typeof baseHooks.loadSeoMeta === 'function';

  if (!hasUserContentHooks && hasRuntimeContentConfig(runtime)) {
    const runtimeHooks = createAdminSiteHooks(
      {
        beforeRequest: baseHooks.beforeRequest,
        onError: baseHooks.onError,
      },
      runtime
    );
    return {
      ...hooks,
      siteBaseUrl,
      apiBaseUrl,
      intl: runtimeHooks.intl,
      beforeRequest: runtimeHooks.beforeRequest,
      loadIntl: runtimeHooks.loadIntl,
      loadSeoMeta: runtimeHooks.loadSeoMeta,
      onError: runtimeHooks.onError,
    } as T;
  }

  return {
    ...hooks,
    siteBaseUrl,
    apiBaseUrl,
  } as T;
}

function createSiteHooks(config: SiteHooksConfig, runtime: SiteRuntimeConfig): ServerHooksOutput {
  const services = resolveRuntimeServices(runtime);
  const api = services.api ?? '';
  const site = runtime.site ?? '';
  const runtimeCtx: SiteRuntimeContext = {
    runtime,
    services,
    telemetry: services.telemetry,
    site: site || undefined,
  };
  const fetchJson = async (path: string, baseUrl?: string): Promise<unknown> => {
    try {
      if (!baseUrl) return null;
      const r = await fetch(baseUrl + path);
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
  // 默认 detect 优先级（业界标准 i18n 顺序）：
  //   1. URL pathname 前缀  /en-US/... → 'en-US'    ← 显式路由意图，最高优先级
  //   2. locale cookie                              ← 用户手动切换过的偏好
  //   3. Accept-Language 头                          ← 浏览器系统语言
  //   4. defaultLocale                              ← 兜底
  //
  // 关键：前缀路由（prefixDefault:true 等场景）下，URL 是源真值。如果不优先用
  // URL，curl /en-US 但 Accept-Language 是 zh 会被错误降级到 zh-CN，跟用户
  // 明确写在 URL 里的意图相反。
  // 业务侧可通过 intlCfg.detect 完全覆盖（任何 (req) => string 都行）。
  const detectLocale =
    intlCfg.detect ??
    ((req: Request): string => {
      // 1. URL 前缀
      if (supportedLocales) {
        try {
          const pathname = new URL(req.url).pathname;
          const first = pathname.split('/')[1];
          if (first && supportedLocales.includes(first)) return first;
        } catch {
          // 非法 URL（极少见，比如内部调用喂了相对路径）→ 继续后续策略
        }
      }
      // 2. cookie
      const localeCookie = readCookie(req, 'locale');
      if (localeCookie) {
        return supportedLocales
          ? normalizeLocale(localeCookie, supportedLocales, fallbackLocale)
          : localeCookie;
      }
      // 3. Accept-Language → 4. fallbackLocale
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
        const json = await fetchJson(url, services.api);
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
          const data = await fetchJson(fillTemplate(remote.endpoint, params), services.api);
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
  const platformOnError = createPlatformOnError(runtime, runtimeCtx);
  const onError: ServerHooksOutput['onError'] = async (err, req, ctx) => {
    platformOnError(err, req, ctx);
    if (config.onError) {
      await config.onError(err, req, ctx);
    }
  };

  const output: ServerHooksOutput = {
    siteBaseUrl: site || undefined,
    apiBaseUrl: api || undefined,
    intl: config.intl,
    headExtras: config.headExtras,
    async beforeRequest(req, _engineCtx) {
      const locale = detectLocale(req);
      const userExt = config.beforeRequest ? await config.beforeRequest(req) : {};
      return { locale, ...userExt };
    },
    async loadIntl(req) {
      return intlLoader(detectLocale(req));
    },
    async loadSeoMeta(req) {
      const url = new URL(req.url);
      const locale = detectLocale(req);
      // 客户端 RSC 导航 fetch 的 URL 带 _.rsc 后缀（详见 defaults/runtime/request.tsx）。
      // 先剥后缀，否则 /zh-CN/books/1_.rsc 永远 match 不到 /books/:id route → seoMeta=null →
      // 客户端导航后 head 不更新。HTML 请求没这个后缀，原行为不变。
      let pathForRouting = url.pathname;
      if (pathForRouting.endsWith('_.rsc')) {
        pathForRouting = pathForRouting.slice(0, -'_.rsc'.length) || '/';
      }
      // SEO 表是按"业务规范路径"（'/' / '/books' / '/about'）入库的，
      // 不带 locale 前缀。请求 URL 是带前缀的（'/en-US/'、'/zh-CN/books'），
      // 直接喂给 admin 查不到。先用 parseLocale 把 locale 段剥掉，
      // 再去 seoRoutes 里匹配 + 调 admin endpoint。
      // 同时 locale 单独传到 resolver params，让 endpoint 模板里 {locale}
      // 占位符能填对应语言（之前那个 fix 留着，跟 strip 配合一起才完整）。
      const intlConfig = config.intl;
      const cleanPath =
        intlConfig?.locales && intlConfig.locales.length > 0
          ? parseLocale(pathForRouting, {
              locales: intlConfig.locales,
              defaultLocale: intlConfig.defaultLocale ?? intlConfig.locales[0]!,
              prefixDefault: intlConfig.prefixDefault,
            } satisfies I18nConfig).pathname
          : pathForRouting;

      for (const { re, paramNames, resolver } of seoRoutes) {
        const m = cleanPath.match(re);
        if (m) {
          const params: Record<string, string> = {
            pathname: cleanPath,
            locale,
          };
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
    configurable: true,
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

/**
 * 逐层剥 envelope —— admin 在不同分支返回三种 shape：
 *   - flat：`{ title, description, ... }`（admin no-locale fast path）
 *   - 单层：`{ data: { title, ... } }`（旧版本）
 *   - 双层：`{ status, code, data: { data: { title, ... }, version } }`
 *     （api-envelope plugin 包了一层，resolvePublic 自己又是 `{ data, version }`，
 *      所以 locale-aware 路径会双层 wrap）
 *
 * 停止条件：候选对象有 `title` / `description`（SEO 形状），或没有 `data` 字段可剥。
 */
function extractSeoMetaOrNull(data: unknown): PageSeoMeta | null {
  let candidate: unknown = data;
  for (let i = 0; i < 4; i++) {
    if (!isRecord(candidate)) return null;
    if ('title' in candidate || 'description' in candidate) break;
    if ('data' in candidate) {
      candidate = candidate.data;
      continue;
    }
    return null;
  }
  if (!isRecord(candidate)) return null;
  return candidate as PageSeoMeta;
}

function normalizeAdminSeoFallbackEntries(
  entries: readonly Record<string, unknown>[] = []
): readonly AdminSeoFallbackEntry[] {
  return entries.filter(
    entry => typeof entry.path === 'string'
  ) as unknown as readonly AdminSeoFallbackEntry[];
}

function createPlatformOnError(
  runtime: SiteRuntimeConfig,
  ctx: SiteRuntimeContext
): NonNullable<ServerHooksOutput['onError']> {
  const reportServerError = createServerErrorEndpointReporter(runtime, ctx);

  return (err, req, errorCtx) => {
    console.error('[onError]', {
      traceId: errorCtx.traceId,
      locale: errorCtx.locale,
      url: req.url,
      msg: err instanceof Error ? err.message : String(err),
    });
    reportServerError?.(err, req, errorCtx);
  };
}

function createServerErrorEndpointReporter(
  runtime: SiteRuntimeConfig,
  ctx: SiteRuntimeContext
): ((err: unknown, req: Request, errorCtx: { traceId: string; locale?: string }) => void) | null {
  const config = runtime.telemetry;
  if (config === false || !config || config.errors === false) return null;

  const errors = config.errors ?? {};
  const endpoint = resolveAdminUrl(errors.endpoint ?? '/api/observability/errors', {}, ctx, {
    baseUrl: runtimeCtx => runtimeCtx.services.telemetry ?? runtimeCtx.services.api,
  });
  if (!endpoint) return null;

  const app = config.app ?? 'novel-isr-app';
  const release = config.release;
  const environment = config.environment;
  const includeQueryString = config.includeQueryString === true;

  return (err, req, errorCtx) => {
    const report = normalizeServerErrorReport(err, req, errorCtx, {
      release,
      environment,
      includeQueryString,
    });

    void fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        app,
        sentAt: Date.now(),
        reports: [report],
      }),
      signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(1000) : undefined,
    }).catch(() => {
      /* 服务端错误上报不能阻断渲染兜底；失败交给进程日志和外层 adapter */
    });
  };
}

function normalizeServerErrorReport(
  err: unknown,
  req: Request,
  ctx: { traceId: string; locale?: string },
  options: {
    release?: string;
    environment?: string;
    includeQueryString?: boolean;
  }
): Record<string, unknown> {
  const error = err instanceof Error ? err : null;
  const message = error?.message || String(err);
  const name = error?.name || 'Error';
  const url = safeRequestPath(req.url, options.includeQueryString);

  return {
    id: createServerReportId(),
    ts: Date.now(),
    level: 'error',
    message,
    name,
    stack: error?.stack,
    release: options.release,
    environment: options.environment,
    url,
    source: 'server-render',
    tags: {
      traceId: ctx.traceId,
      locale: ctx.locale,
    },
    extra: {
      method: req.method,
      pathname: url.split('?')[0] || '/',
    },
    fingerprint: ['server-render', name, message.slice(0, 160)],
  };
}

function safeRequestPath(rawUrl: string, includeQueryString?: boolean): string {
  try {
    const url = new URL(rawUrl);
    return includeQueryString ? `${url.pathname}${url.search}` : url.pathname;
  } catch {
    return includeQueryString ? rawUrl : '/';
  }
}

function createServerReportId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `srv_${Date.now().toString(36)}_${random}`;
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
  options: { baseUrl?: RuntimeServiceBase } = {}
): string | null {
  const filled = fillTemplate(endpoint, vars);
  if (/^(https?:)?\/\//i.test(filled)) return filled;
  const base = resolveRuntimeServiceBase(ctx, options.baseUrl);
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${filled.replace(/^\/+/, '')}`;
}

function resolveRuntimeServiceBase(
  ctx: SiteRuntimeContext,
  baseUrl?: RuntimeServiceBase
): string | null {
  if (typeof baseUrl === 'function') {
    return baseUrl(ctx) ?? null;
  }
  if (baseUrl) return baseUrl;
  return ctx.services.api ?? null;
}

function resolveRuntimeServices(runtime: SiteRuntimeConfig): RuntimeServices {
  const services = runtime.services ?? {};
  const api = services.api;
  return {
    api,
    telemetry: services.telemetry ?? api,
  };
}

function hasRuntimeContentConfig(runtime: SiteRuntimeConfig): boolean {
  return !!(
    runtime.i18n?.endpoint ||
    runtime.i18n?.fallbackLocal ||
    runtime.seo?.endpoint ||
    runtime.seo?.fallbackLocal ||
    runtime.telemetry
  );
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
