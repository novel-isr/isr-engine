/**
 * defineServerEntry —— FaaS 风格的服务端入口工厂
 *
 * 用户态写法（覆盖 engine 默认行为）：
 *
 *   // src/entry.server.tsx
 *   import { defineServerEntry } from '@novel-isr/engine/server-entry';
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
// @app 别名在 createIsrPlugin 注入；评估用户 src/routes.tsx 以注册 page-level SEO
import '@app/_routes';

import { parseRenderRequest } from './request';
import { type IntlPayload, type PageSeoMeta, injectSeoMeta, mergePageSeoMeta } from './seo-runtime';
import { runWithI18n } from './i18n-server';
import { resolvePageSeoMeta } from '../../runtime/routes';
import { getRequestContext } from '../../context/RequestContext';

interface DefaultRscPayload {
  root: React.ReactNode;
  intl?: IntlPayload | null;
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

/** 生成一个紧凑的 trace-id（10 位 base36，约 2^52 / 1e6 = 4.5T 条不重碰）*/
function genTraceId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defineServerEntry<C extends ServerCtx = ServerCtx>(
  hooks: ServerEntryHooks<C> = {}
): ServerEntryModule {
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

        const seoMeta = await runWithI18n(intl, async () => {
          const url = new URL(request.url);
          const [pageSeoMeta, hookSeoMeta] = await Promise.all([
            resolvePageSeoMeta(url),
            hooks.loadSeoMeta
              ? Promise.resolve(hooks.loadSeoMeta(request, ctx))
              : Promise.resolve(null),
          ]);
          return mergePageSeoMeta(pageSeoMeta, hookSeoMeta);
        });
        if (seoMeta) (ctx as ServerCtx).seoMeta = seoMeta;

        const response = await runWithI18n(intl, () =>
          runRscPipeline(request, {
            intl,
            seoMeta,
            siteBaseUrl: hooks.siteBaseUrl,
            apiBaseUrl: hooks.apiBaseUrl,
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
  intl: IntlPayload | null | undefined;
  seoMeta: PageSeoMeta | null | undefined;
  siteBaseUrl?: string;
  apiBaseUrl?: string;
}

/** 内部固化的 RSC + SSR 协议流水线 —— 用户不可见 */
async function runRscPipeline(request: Request, extras: PipelineExtras): Promise<Response> {
  const renderRequest = parseRenderRequest(request);
  request = renderRequest.request;

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

  const rscPayload: DefaultRscPayload = {
    root: <App url={renderRequest.url} intl={extras.intl ?? undefined} />,
    intl: extras.intl ?? null,
    formState,
    returnValue,
  };
  const rscStream = renderToReadableStream<DefaultRscPayload>(rscPayload, { temporaryReferences });

  if (renderRequest.isRsc) {
    return new Response(rscStream, {
      status: actionStatus,
      headers: { 'content-type': 'text/x-component;charset=utf-8' },
    });
  }

  interface SsrModule {
    renderHTML: (
      rscStream: ReadableStream<Uint8Array>,
      options: {
        formState?: ReactFormState;
        nonce?: string;
        debugNojs?: boolean;
        forceCsrShell?: boolean;
        apiBaseUrl?: string;
      }
    ) => Promise<{
      stream: ReadableStream<Uint8Array>;
      status?: number;
      csrShellFallback?: boolean;
    }>;
  }
  const ssrEntry = await import.meta.viteRsc.loadModule<SsrModule>('ssr', 'index');

  const ssrResult = await ssrEntry.renderHTML(rscStream, {
    formState,
    debugNojs: renderRequest.url.searchParams.has('__nojs'),
    forceCsrShell: renderRequest.url.searchParams.has('__csr-shell'),
    apiBaseUrl: extras.apiBaseUrl,
  });

  const responseHeaders = new Headers();
  responseHeaders.set('content-type', 'text/html; charset=utf-8');
  responseHeaders.set('x-render-strategy', ssrResult.csrShellFallback ? 'csr-shell' : 'rsc-ssr');
  responseHeaders.set('x-fallback-used', ssrResult.csrShellFallback ? 'true' : 'false');
  if (ssrResult.csrShellFallback) {
    responseHeaders.set('x-fallback-target', 'client createRoot fallback shell');
  }

  // 仅当用户提供 seoMeta 且非 csr-shell 兜底时注入；csr-shell 的 head 已固化
  // 把 siteBaseUrl 传给 injectSeoMeta，让相对路径 (image/canonical) 解析为绝对 URL
  // 注：theme 不再由 engine 注入 ——
  // 业界 (shadcn / next-themes / Tailwind) 标准做法是 head 里塞一个内联阻塞 <script>，
  // 同步读 localStorage 把 data-theme 写到 documentElement，这样首屏前就生效，
  // 跟客户端 ThemeProvider 用同一个 storage key 不会打架。engine 拿不到 localStorage，
  // 不该也无法做这件事 —— 业务侧自己在 layout.tsx <head> 里塞脚本。
  const finalStream =
    extras.seoMeta && !ssrResult.csrShellFallback
      ? injectSeoMeta(ssrResult.stream, extras.seoMeta, extras.siteBaseUrl)
      : ssrResult.stream;

  return new Response(finalStream, {
    status: ssrResult.status,
    headers: responseHeaders,
  });
}
