/**
 * defineServerEntry —— FaaS 风格的服务端入口工厂
 *
 * 用户态写法（覆盖 engine 默认行为）：
 *
 *   // src/entry.server.tsx
 *   import { defineServerEntry } from 'isr-engine/server-entry';
 *   export default defineServerEntry({
 *     beforeRequest: (req) => ({ traceId: crypto.randomUUID() }),
 *     onResponse:    (res, ctx) => res.headers.set('x-trace-id', ctx.traceId),
 *     onError:       (err)      => console.error('render failed', err),
 *   });
 *
 * 不传任何 hook 时（engine 默认入口的写法）：
 *
 *   export default defineServerEntry();    // 一行搞定
 *
 * Hook 之外的全部协议细节（RSC / Server Action / SSR loadModule / csr-shell 透传）
 * 由本工厂内部固化实现，用户**不需要**了解或重写。
 */
import {
  createTemporaryReferenceSet,
  decodeAction,
  decodeFormState,
  decodeReply,
  loadServerAction,
  renderToReadableStream,
} from '@vitejs/plugin-rsc/rsc';
import type { ReactFormState } from 'react-dom/client';

// @ts-expect-error - @app 别名在 createIsrPlugin 注入；指向用户的 src/app.tsx
import { App } from '@app/_entry';
// @ts-expect-error - App route manifest resolved by createIsrPlugin.
import * as appRoutes from '@app/_routes';
// @ts-expect-error - Runtime config resolved by createIsrPlugin.
import runtimeConfig from 'virtual:isr-engine/runtime-config';

import { parseRenderRequest, type RenderRequest } from './request';
import {
  declareDevClientReferenceStyles,
  runWithDevStyleDeclarationCollection,
} from './dev-style-declarations.server';
import { type IntlPayload, type PageSeoMeta, injectSeoMeta, mergePageSeoMeta } from './seo-runtime';
import { injectHeadExtras } from './head-extras-runtime';
import { runWithI18n } from './i18n-server';
import { resolvePageRoute, type ResolveRoute } from '../../runtime/routes';
import {
  isNoAcceptableLocaleError,
  parseLocale,
  resolveI18nConfig,
  type I18nConfig,
} from '../../runtime/i18n';
import type { RuntimeConfig } from '../../types/ISRConfig';
import { getRequestContext } from '../../context/RequestContext';
import { createRenderErrorHandler, isRenderCancellation } from './renderCancellation';

interface DefaultRscPayload {
  root: React.ReactNode;
  intl?: IntlPayload | null;
  /**
   * 页面 SEO meta —— 与 intl 对齐的客户端 head 同步通道。
   * 首屏 SSR 通过 injectSeoMeta 把 meta 注入到 HTML 流；客户端 RSC 导航时
   * 单独从 payload 读出来调用 applySeoToDocument 同步 document.title / meta /
   * canonical / og:* / jsonLd —— 不然点链接进新页面 title 不变（hint：上次
   * SSR 注入的 head 不会跟着 React 树重渲染）。
   */
  seoMeta?: PageSeoMeta | null;
  /** 客户端 applySeoToDocument 用来把 canonical / og:image 转绝对 URL */
  siteBaseUrl?: string | null;
  routeStatus?: 404;
  returnValue?: { ok: boolean; data: unknown };
  formState?: ReactFormState;
}

/** 默认始终注入的请求上下文 —— engine 自动维护，不需要用户写代码 */
export interface EngineRequestContext {
  /** trace-id：从入站头 X-Request-Id / X-Trace-Id 读取，没有则自动生成 */
  traceId: string;
  /** 请求处理起点（毫秒）—— 用于自动算 X-Render-Ms */
  startedAt: number;
}

/** 用户 hook 之间共享的请求级上下文（engine 字段 + 用户扩展） */
export type ServerCtx = EngineRequestContext & Record<string, unknown>;

export interface ServerEntryHooks<C extends ServerCtx = ServerCtx> {
  /**
   * 站点根 URL —— SEO 注入时把 image/canonical 等相对路径解析为绝对 URL
   * defineSiteHooks 自动从 site 字段填入；用户也可手动设
   */
  siteBaseUrl?: string;
  /**
   * 浏览器可访问的 API base —— 注入到 csr-shell 的 window.__API_BASE__
   * defineSiteHooks 自动从 api 字段填入；CSR fallback 的 loader 用此 URL 拉数据
   */
  apiBaseUrl?: string;
  /**
   * 请求进入时调用 —— 返回的对象**与 engine 请求上下文合并**作为后续 hook 的 ctx，
   * 同时同步到 RequestContext，Server Component 可用 getRequestContext() 读取。
   *
   * 适用：
   *   - 从 header / cookie 解析 userId。
   *   - 从域名 / header / 路径解析 tenantId。
   *   - 注入 requestSegment、渠道、风控或审计字段。
   *
   * 注意：trace-id 和 startedAt 由 engine 自动维护，**不需要**在这里手动设
   * 注意：A/B variant 由 runtime.experiments + middleware 注入，页面用 getVariant()。
   * 不要在这里解析 ab cookie 或做慢 API / 数据库查询。
   */
  beforeRequest?: (
    request: Request,
    engineCtx: EngineRequestContext
  ) => Partial<C> | Promise<Partial<C>>;
  /**
   * Response 返回前调用 —— 用于追加自定义响应头
   *
   * 注意：x-trace-id 和 x-render-ms 由 engine 自动注入，**不需要**在这里手动加
   */
  onResponse?: (response: Response, ctx: C) => void | Promise<void>;
  /**
   * 渲染抛错时调用 —— 用于上报 / 打点；engine 仍会按 FallbackChain 走 csr-shell
   * 不要在这里返回 Response —— 兜底由 engine 处理
   */
  onError?: (error: unknown, request: Request, ctx: C) => void | Promise<void>;
  /** URL locale settings exposed by site hooks. */
  intl?: Partial<I18nConfig>;
  /**
   * 单页 i18n 数据加载器 —— 返回值经 RSC payload 序列化到客户端
   *
   * - 返回 null/undefined 时跳过（无 i18n）
   * - engine 把结果作为 `intl` prop 传给 App，并写入 ctx.intl
   * - 推荐用 createCachedFetcher 包装远程 URL；本地 JSON 直接 `import()` 即可
   *
   * @example
   *   loadIntl: async (req, ctx) => {
   *     const locale = req.headers.get('accept-language')?.split(',')[0] ?? 'en';
   *     return loadMessagesCached({ locale });   // 见 createCachedFetcher
   *   }
   */
  loadIntl?: (
    request: Request,
    ctx: C
  ) => IntlPayload | null | undefined | Promise<IntlPayload | null | undefined>;
  /**
   * 单页 SEO 元数据加载器 —— engine 在 SSR HTML <head> 里自动注入对应标签
   *
   * - 返回 null/undefined 时不注入（保留 SSR 默认 head）
   * - 用户**不需要**在自己的组件里写 <title>/<meta>
   *
   * @example
   *   loadSeoMeta: async (req) => {
   *     const url = new URL(req.url);
   *     if (url.pathname.startsWith('/books/')) {
   *       const book = await fetchBookCached(url.pathname.split('/')[2]);
   *       return { title: book.title, description: book.summary, image: book.cover };
   *     }
   *     return null;
   *   }
   */
  loadSeoMeta?: (
    request: Request,
    ctx: C
  ) => PageSeoMeta | null | undefined | Promise<PageSeoMeta | null | undefined>;
}

export interface ServerEntryModule {
  fetch: (request: Request) => Promise<Response>;
}

/** Node 24 and supported edge runtimes expose the Web Crypto UUID generator. */
function genTraceId(): string {
  return `t-${crypto.randomUUID()}`;
}

export function defineServerEntry<C extends ServerCtx = ServerCtx>(
  hooks: ServerEntryHooks<C> = {}
): ServerEntryModule {
  const configuredIntl = hooks.intl?.locales?.length
    ? hooks.intl
    : (runtimeConfig as Partial<RuntimeConfig> | undefined)?.i18n;
  const routeI18n = configuredIntl?.locales?.length ? resolveI18nConfig(configuredIntl) : undefined;
  return {
    async fetch(request) {
      const requestStore = getRequestContext();

      // ─── engine request context（每个请求自动有）───────────────
      const engineCtx: EngineRequestContext = {
        traceId:
          request.headers.get('x-request-id') ||
          request.headers.get('x-trace-id') ||
          requestStore?.traceId ||
          genTraceId(),
        startedAt: Date.now(),
      };
      let ctx: C = { ...(requestStore ?? {}), ...engineCtx } as C;

      try {
        request.signal.throwIfAborted();
        if (hooks.beforeRequest) {
          const userExt = (await hooks.beforeRequest(request, engineCtx)) ?? {};
          ctx = { ...(requestStore ?? {}), ...engineCtx, ...userExt } as C;
        }
        if (requestStore) {
          Object.assign(requestStore, ctx);
        }

        // ─── i18n 先加载并进入请求作用域；SEO 可在 page seo 中直接 getI18n() ─────
        const intl = hooks.loadIntl ? await Promise.resolve(hooks.loadIntl(request, ctx)) : null;
        if (intl) {
          (ctx as ServerCtx).intl = intl;
          if (requestStore) {
            requestStore.intl = intl;
          }
        }

        const renderRequest = parseRenderRequest(request);
        const url = new URL(renderRequest.url);
        const localeConfig =
          routeI18n ?? (intl?.locale && { locales: [intl.locale], defaultLocale: intl.locale });
        const localized = localeConfig ? parseLocale(url.pathname, localeConfig) : undefined;
        if (localized?.hasPrefix) url.pathname = localized.pathname;

        const routeResolver = (Reflect.get(appRoutes, 'routes') ??
          Reflect.get(appRoutes, 'default')) as ResolveRoute | undefined;
        const { seoMeta, notFound } = await runWithI18n(intl, async () => {
          const [page, hookSeoMeta] = await Promise.all([
            resolvePageRoute(url, routeResolver),
            hooks.loadSeoMeta
              ? Promise.resolve(hooks.loadSeoMeta(request, ctx))
              : Promise.resolve(null),
          ]);
          const merged = mergePageSeoMeta(page.seoMeta, hookSeoMeta);
          const canonical = merged?.canonical;
          const seoMeta =
            localized?.hasPrefix && canonical?.startsWith('/') && !canonical.startsWith('//')
              ? {
                  ...merged,
                  canonical:
                    canonical === '/' ? `/${localized.locale}` : `/${localized.locale}${canonical}`,
                }
              : merged;
          return { seoMeta, notFound: page.notFound };
        });
        if (seoMeta) (ctx as ServerCtx).seoMeta = seoMeta;

        // headExtras hook 容错：抛错不应阻塞 SSR（业务侧返回值类型 unknown 时安全降级）。
        // 把当前请求的 CSP nonce 透传给业务，让 inline <script> 能带 nonce 通过 CSP。
        let headExtras: string | undefined;
        try {
          const headExtrasNonce = request.headers.get('x-csp-nonce') ?? undefined;
          const raw = hooks.headExtras?.({ nonce: headExtrasNonce });
          if (typeof raw === 'string' && raw.length > 0) headExtras = raw;
        } catch {
          // 业务 hook 异常 → 当作没有 headExtras，继续渲染
        }

        const response = await runWithI18n(intl, () =>
          runRscPipeline(renderRequest, {
            routeStatus: notFound ? 404 : undefined,
            intl,
            seoMeta,
            siteBaseUrl: hooks.siteBaseUrl,
            apiBaseUrl: hooks.apiBaseUrl,
            headExtras,
          })
        );

        // ─── 自动注入观测头（用户无需写代码）──────────────────
        response.headers.set('x-trace-id', engineCtx.traceId);
        response.headers.set('x-render-ms', String(Date.now() - engineCtx.startedAt));
        if (intl?.locale) response.headers.set('content-language', intl.locale);
        if (intl?.source) response.headers.set('x-i18n-source', intl.source);

        if (hooks.onResponse) {
          await hooks.onResponse(response, ctx);
        }
        return response;
      } catch (err) {
        if (isRenderCancellation(request.signal, err)) return new Response(null, { status: 204 });
        if (isNoAcceptableLocaleError(err)) {
          return new Response(null, {
            status: 406,
            headers: { vary: 'Accept-Language, Cookie', 'cache-control': 'no-store' },
          });
        }
        if (hooks.onError) {
          try {
            await hooks.onError(err, request, ctx);
          } catch {
            /* hook 内部抛错不能影响兜底 */
          }
        }
        throw err;
      }
    },
  };
}

interface PipelineExtras {
  routeStatus?: 404;
  intl: IntlPayload | null | undefined;
  seoMeta: PageSeoMeta | null | undefined;
  siteBaseUrl?: string;
  apiBaseUrl?: string;
  /** 注入 `<head>` 末尾的 raw HTML（业务侧 site-hooks.headExtras() 的返回值） */
  headExtras?: string;
}

/** 内部固化的 RSC + SSR 协议流水线 —— 用户不可见 */
async function runRscPipeline(
  renderRequest: RenderRequest,
  extras: PipelineExtras
): Promise<Response> {
  const { request } = renderRequest;
  const responseRouteStatus = renderRequest.isAction ? undefined : extras.routeStatus;
  const signal = request.signal;
  signal.throwIfAborted();
  const responseHeaders = new Headers({
    'content-type': renderRequest.isRsc
      ? 'text/x-component;charset=utf-8'
      : 'text/html; charset=utf-8',
  });
  if (request.method === 'HEAD') {
    return new Response(null, { status: responseRouteStatus, headers: responseHeaders });
  }

  let returnValue: DefaultRscPayload['returnValue'] | undefined;
  let formState: ReactFormState | undefined;
  let temporaryReferences: unknown | undefined;
  let actionStatus: number | undefined;

  if (renderRequest.isAction) {
    if (renderRequest.actionId) {
      const contentType = request.headers.get('content-type');
      const body = contentType?.startsWith('multipart/form-data')
        ? await request.formData()
        : await request.text();
      temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = await loadServerAction(renderRequest.actionId);
      try {
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (e) {
        returnValue = { ok: false, data: e };
        actionStatus = 500;
      }
    } else {
      const formData = await request.formData();
      const decodedAction = await decodeAction(formData);
      try {
        const result = await decodedAction();
        formState = await decodeFormState(result, formData);
      } catch {
        return new Response('Internal Server Error: server action failed', { status: 500 });
      }
    }
  }

  const devStyleDeclarations = import.meta.env.DEV ? [] : undefined;
  const rscPayload: DefaultRscPayload = {
    root: <App url={renderRequest.url} intl={extras.intl ?? undefined} />,
    intl: extras.intl ?? null,
    seoMeta: extras.seoMeta ?? null,
    siteBaseUrl: extras.siteBaseUrl ?? null,
    routeStatus: extras.routeStatus,
    formState,
    returnValue,
  };
  const renderOptions = { temporaryReferences, signal, onError: createRenderErrorHandler(signal) };
  const rscStream = import.meta.env.DEV
    ? runWithDevStyleDeclarationCollection(
        devStyleDeclarations!,
        () =>
          renderToReadableStream<DefaultRscPayload>(rscPayload, renderOptions, {
            onClientReference: declareDevClientReferenceStyles,
          }),
        { transportGeneration: renderRequest.devStyleGeneration }
      )
    : renderToReadableStream<DefaultRscPayload>(rscPayload, renderOptions);

  if (renderRequest.isRsc) {
    return new Response(rscStream, {
      status: actionStatus ?? responseRouteStatus,
      headers: responseHeaders,
    });
  }

  const ssrEntry = await import.meta.viteRsc.loadModule<
    Pick<typeof import('../entry.server.ssr'), 'renderHTML'>
  >('ssr', 'index');

  // CSP nonce —— 由上游 createCspNonceMiddleware 生成并写到 req header 'x-csp-nonce'。
  // React 19 renderToReadableStream 接 nonce 选项后，自动给所有内联 script (RSC payload、
  // bootstrap、metadata) 打 nonce 属性。再配合 helmet CSP `script-src 'nonce-XXX'`，
  // 整套 nonce-based CSP 闭环；Lighthouse csp-xss 不再判 'unsafe-inline' 高危。
  const cspNonce = request.headers.get('x-csp-nonce') ?? undefined;

  const ssrResult = await ssrEntry.renderHTML(rscStream, {
    formState,
    nonce: cspNonce,
    debugNojs: renderRequest.url.searchParams.has('__nojs'),
    forceCsrShell: renderRequest.url.searchParams.has('__csr-shell'),
    apiBaseUrl: extras.apiBaseUrl,
    signal,
  });

  responseHeaders.set('x-render-strategy', ssrResult.csrShellFallback ? 'csr-shell' : 'rsc-ssr');
  responseHeaders.set('x-fallback-used', ssrResult.csrShellFallback ? 'true' : 'false');
  if (ssrResult.csrShellFallback) {
    responseHeaders.set('x-fallback-target', 'client createRoot fallback shell');
  }

  // SSR HTML stream pipeline —— 仅在非 csr-shell 兜底时注入（csr-shell 的 head 已固化）：
  //   1. SEO meta 抢首位（紧跟 `<head>` 开标签）—— 浏览器对 `<title>` 单值标签只取第一个
  //   2. headExtras 末尾插入（`</head>` 之前）—— 业务侧 site-hooks.headExtras() 返回的
  //      raw HTML，典型是 theme init inline blocking script、GA snippet 等
  // 两者都脱离 React 树，不进 client RSC payload，不会触发 hydration mismatch。
  let finalStream = ssrResult.stream;
  if (!ssrResult.csrShellFallback) {
    if (extras.seoMeta) {
      finalStream = injectSeoMeta(
        finalStream,
        extras.seoMeta,
        extras.siteBaseUrl,
        extras.routeStatus
      );
    }
    if (extras.headExtras) {
      finalStream = injectHeadExtras(finalStream, extras.headExtras);
    }
  }

  return new Response(finalStream, {
    status: ssrResult.status ?? responseRouteStatus,
    headers: responseHeaders,
  });
}
