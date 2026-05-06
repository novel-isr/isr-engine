/**
 * defineClientEntry —— FaaS 风格的浏览器入口工厂
 *
 * 用户态写法（覆盖 engine 默认行为）：
 *
 *   // src/entry.tsx
 *   export default {
 *     devInspector: true,
 *     // beforeStart / onNavigate / onActionError 是高级逃生口：
 *     // 普通 PV、Web Vitals、全局错误、Server Action 错误由 runtime.telemetry 自动处理。
 *   };
 *
 * 不传任何 hook 时（engine 默认入口的写法）：
 *
 *   defineClientEntry();    // 一行搞定
 *
 * Hook 之外的全部协议细节（initial Flight 反序列化 / hydrateRoot vs createRoot 决策 /
 * popstate / pushState 拦截 / Server Action setServerCallback / HMR）由本工厂内部
 * 固化实现，用户**不需要**了解或重写。
 */
import {
  createFromFetch,
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from '@vitejs/plugin-rsc/browser';
import * as React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { rscStream } from 'rsc-html-stream/client';

import { GlobalErrorBoundary } from './error-boundary';
import { HydrationShell } from './hydration-shell';
import { createRscRenderRequest } from './request';
import { installDevRenderInspector } from './dev-render-inspector';
import { setClientI18n } from '../../runtime/i18n-store';
import type { IntlPayload } from './seo-runtime';
import {
  installBrowserObservability,
  type BrowserObservabilityHandle,
  type BrowserObservabilityOptions,
} from './browserObservability';

interface DefaultRscPayload {
  root: React.ReactNode;
  intl?: IntlPayload | null;
  formState?: import('react-dom/client').ReactFormState;
  returnValue?: { ok: boolean; data: unknown };
}

/**
 * csr-shell 友好降级页 —— 服务端崩溃时给用户的最终页面
 *
 * 设计原则：
 *   - 不尝试自动恢复（自动 _.rsc fetch 大概率也失败 —— server 还没起来）
 *   - 不让任何 server 错误进 React 树（避免 console 噪声 + 错误传播）
 *   - 给用户明确状态（不是白屏，不是错误堆栈）+ 显式 retry 按钮
 *
 * 类比：成熟产品的 outage / recovery 页面。
 */
function CsrShellFallback(): React.ReactElement {
  return React.createElement(
    'html',
    { lang: 'zh-CN' },
    React.createElement(
      'head',
      null,
      React.createElement('meta', { charSet: 'utf-8' }),
      React.createElement('title', null, '服务暂时不可用'),
      React.createElement('style', {
        dangerouslySetInnerHTML: {
          __html: `
            :root { color-scheme: dark; }
            body { margin:0; background:#111418; color:#e7edf4; font:14px Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
            .csr-shell-page { min-height:100vh; display:grid; place-items:center; padding:32px 20px; }
            .csr-shell-card { width:min(520px,100%); padding:28px; border:1px solid rgba(255,255,255,.12); border-radius:8px; background:#171b21; box-shadow:0 24px 80px rgba(0,0,0,.32); }
            .csr-shell-badge { display:inline-flex; align-items:center; height:24px; padding:0 10px; border:1px solid rgba(125,211,252,.24); border-radius:999px; background:rgba(14,165,233,.12); color:#7dd3fc; font-size:12px; font-weight:700; letter-spacing:0; }
            .csr-shell-card h1 { margin:18px 0 8px; color:#f8fafc; font-size:clamp(24px,4vw,34px); line-height:1.15; letter-spacing:0; }
            .csr-shell-card p { margin:0; color:#aab4c1; line-height:1.7; }
            .csr-shell-grid { display:grid; gap:10px; margin-top:22px; }
            .csr-shell-row { display:flex; justify-content:space-between; gap:16px; padding:12px; border:1px solid rgba(255,255,255,.08); border-radius:8px; background:rgba(255,255,255,.04); }
            .csr-shell-row span:first-child { color:#8894a3; }
            .csr-shell-row span:last-child { color:#f8fafc; font-weight:700; text-align:right; }
            .csr-shell-page button { min-height:38px; margin-top:22px; padding:0 16px; border:0; border-radius:6px; background:#f97316; color:#111418; font-weight:800; cursor:pointer; }
            .csr-shell-page button:focus-visible { outline:2px solid #fed7aa; outline-offset:2px; }
            .csr-shell-page button:hover { background:#fb923c; }
          `,
        },
      })
    ),
    React.createElement(
      'body',
      null,
      React.createElement(
        'div',
        { className: 'csr-shell-page' },
        React.createElement(
          'main',
          { className: 'csr-shell-card', role: 'status', 'aria-live': 'polite' },
          React.createElement('span', { className: 'csr-shell-badge' }, 'CSR fallback'),
          React.createElement('h1', null, '服务端暂时不可用'),
          React.createElement(
            'p',
            null,
            '客户端自救也未能拿到 RSC 数据。请稍后重新加载，或检查服务端日志。'
          ),
          React.createElement(
            'div',
            { className: 'csr-shell-grid', 'aria-label': '降级状态' },
            React.createElement(
              'div',
              { className: 'csr-shell-row' },
              React.createElement('span', null, 'Render strategy'),
              React.createElement('span', null, 'client recovery')
            ),
            React.createElement(
              'div',
              { className: 'csr-shell-row' },
              React.createElement('span', null, 'Next action'),
              React.createElement('span', null, 'retry')
            )
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: () => location.reload() },
            '重新加载'
          )
        )
      )
    )
  );
}

export interface ClientEntryHooks {
  /** Client runtime 启动前调用 —— 适合第三方 SDK 初始化或设置 telemetry user，不负责常规第一方上报 */
  beforeStart?: (ctx: ClientEntryHookContext) => void | Promise<void>;
  /** 客户端导航发生时调用；第一方 page_view 已自动上报，这里只做业务补充或第三方 breadcrumb */
  onNavigate?: (url: URL, ctx: ClientEntryHookContext) => void;
  /** Server Action 调用失败时调用；第一方错误已自动上报，这里只做业务补充或第三方 breadcrumb */
  onActionError?: (error: unknown, actionId: string, ctx: ClientEntryHookContext) => void;
  /**
   * 浏览器 telemetry。engine 接管启动、导航和 Server Action 失败这些生命周期点；
   * 具体上报只通过 ssr.config.ts runtime.telemetry 里的 endpoint。
   * engine 不 import `@novel-isr/analytics` / `@novel-isr/error-reporting`；
   * 这两个独立 SDK 只给非 engine 应用或业务自定义接入使用。
   */
  telemetry?: false | BrowserObservabilityOptions;
  /**
   * 开发态渲染检查器。默认启用；业务如需完全隐藏可在 src/entry.tsx 返回
   * `{ devInspector: false }`。
   */
  devInspector?: boolean;
}

export type ClientEntryTelemetryApi = Pick<
  BrowserObservabilityHandle,
  'track' | 'capture' | 'measure' | 'page' | 'setUser' | 'flush'
>;

export interface ClientEntryHookContext {
  telemetry: ClientEntryTelemetryApi;
}

export function defineClientEntry(hooks: ClientEntryHooks = {}): void {
  void main(hooks);
}

async function main(hooks: ClientEntryHooks): Promise<void> {
  const observability =
    hooks.telemetry && hooks.telemetry !== false
      ? await installBrowserObservability(hooks.telemetry)
      : null;
  const hookContext = createHookContext(observability);

  if (hooks.beforeStart) await hooks.beforeStart(hookContext);

  const installInspector = () => {
    if (hooks.devInspector === false) return;
    try {
      installDevRenderInspector();
    } catch {
      /* dev inspector 不能阻断业务客户端启动 */
    }
  };

  // Inspector 必须先于 RSC 反序列化和 hydrateRoot 安装：
  // 首屏 RSC / hydration / dynamic import 任一环节失败时，开发者仍能看到真实渲染模式。
  installInspector();

  function schedulePostCommitInspectorInstall(): void {
    if (hooks.devInspector === false) return;
    const installAfterCommit = () => {
      installInspector();
      window.setTimeout(installInspector, 0);
      window.setTimeout(installInspector, 50);
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(installAfterCommit);
      return;
    }

    window.setTimeout(installAfterCommit, 0);
  }

  function mountRscShellFallback(): void {
    document.body.classList.remove('csr-shell-body');
    document.body.removeAttribute('style');

    let setPayload: (v: DefaultRscPayload) => void = () => {};

    async function fetchRscPayload(): Promise<void> {
      const renderRequest = createRscRenderRequest(window.location.href);
      const payload = await createFromFetch<DefaultRscPayload>(fetch(renderRequest));
      setClientI18n(payload.intl);
      setPayload(payload);
    }

    function RscShellRoot(): React.ReactNode {
      const [payload, setPayload_] = React.useState<DefaultRscPayload | null>(null);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(() => {
        setPayload = v => React.startTransition(() => setPayload_(v));
      }, [setPayload_]);

      React.useEffect(() => {
        fetchRscPayload().catch(() => setFailed(true));
        return listenNavigation(
          () => {
            setFailed(false);
            fetchRscPayload().catch(() => setFailed(true));
          },
          hooks.onNavigate,
          observability,
          hookContext
        );
      }, []);

      if (failed) return React.createElement(CsrShellFallback);
      if (!payload) {
        return React.createElement(
          'html',
          { lang: 'zh-CN' },
          React.createElement(
            'body',
            null,
            React.createElement('div', { className: 'csr-shell-page' }, '加载中…')
          )
        );
      }
      return payload.root;
    }

    setServerCallback(async (id: string, args: unknown[]) => {
      const temporaryReferences = createTemporaryReferenceSet();
      const renderRequest = createRscRenderRequest(window.location.href, {
        id,
        body: await encodeReply(args, { temporaryReferences }),
      });
      const payload = await createFromFetch<DefaultRscPayload>(fetch(renderRequest), {
        temporaryReferences,
      });
      setClientI18n(payload.intl);
      setPayload(payload);
      const { ok, data } = payload.returnValue!;
      if (!ok) {
        captureActionError(observability, data, id);
        if (hooks.onActionError) {
          try {
            hooks.onActionError(data, id, hookContext);
          } catch {
            /* hook 抛错不影响主流程 */
          }
        }
        throw data;
      }
      return data;
    });

    createRoot(document as unknown as Element).render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(GlobalErrorBoundary, null, React.createElement(RscShellRoot))
      )
    );
    schedulePostCommitInspectorInstall();
  }

  // SPA fallback：浏览器加载 dist/spa/index.html 触发，由部署层（Nginx/CDN）在 SSR 5xx 时切入
  if ((globalThis as { __SPA_MODE__?: boolean }).__SPA_MODE__) {
    mountRscShellFallback();
    installInspector();
    return;
  }

  // SSR 渲染抛异常的 csr-shell 兜底分支（与 __SPA_MODE__ 不同：这是 SSR 半死状态）
  if ('__NO_HYDRATE' in globalThis) {
    mountRscShellFallback();
    installInspector();
    return;
  }

  let setPayload: (v: DefaultRscPayload) => void = () => {};
  const initialPayload = await createFromReadableStream<DefaultRscPayload>(rscStream);
  setClientI18n(initialPayload.intl);

  function BrowserRoot(): React.ReactNode {
    const [payload, setPayload_] = React.useState(initialPayload);
    React.useEffect(() => {
      setPayload = v => React.startTransition(() => setPayload_(v));
    }, [setPayload_]);
    React.useEffect(
      () => listenNavigation(fetchRscPayload, hooks.onNavigate, observability, hookContext),
      []
    );
    return payload.root;
  }

  async function fetchRscPayload(): Promise<void> {
    const renderRequest = createRscRenderRequest(window.location.href);
    const payload = await createFromFetch<DefaultRscPayload>(fetch(renderRequest));
    setClientI18n(payload.intl);
    setPayload(payload);
  }

  setServerCallback(async (id: string, args: unknown[]) => {
    const temporaryReferences = createTemporaryReferenceSet();
    const renderRequest = createRscRenderRequest(window.location.href, {
      id,
      body: await encodeReply(args, { temporaryReferences }),
    });
    const payload = await createFromFetch<DefaultRscPayload>(fetch(renderRequest), {
      temporaryReferences,
    });
    setClientI18n(payload.intl);
    setPayload(payload);
    const { ok, data } = payload.returnValue!;
    if (!ok) {
      captureActionError(observability, data, id);
      if (hooks.onActionError) {
        try {
          hooks.onActionError(data, id, hookContext);
        } catch {
          /* hook 抛错不影响主流程 */
        }
      }
      throw data;
    }
    return data;
  });

  const browserRoot = (
    <HydrationShell>
      <BrowserRoot />
    </HydrationShell>
  );

  // 注：csr-shell 路径已在 main 入口处早返回，这里只剩正常水合
  hydrateRoot(document, browserRoot, { formState: initialPayload.formState });
  installInspector();
  schedulePostCommitInspectorInstall();

  if (import.meta.hot) {
    import.meta.hot.on('rsc:update', () => {
      void fetchRscPayload();
    });
  }
}

function captureActionError(
  observability: BrowserObservabilityHandle | null,
  error: unknown,
  actionId: string
): void {
  try {
    observability?.captureActionError(error, actionId);
  } catch {
    /* observability hook 抛错不影响 Server Action 语义 */
  }
}

function listenNavigation(
  onNavigation: () => void,
  onNavigateHook?: (url: URL, ctx: ClientEntryHookContext) => void,
  observability?: BrowserObservabilityHandle | null,
  hookContext: ClientEntryHookContext = createHookContext(null)
): () => void {
  const fire = () => {
    onNavigation();
    const url = new URL(window.location.href);
    try {
      observability?.page(url);
    } catch {
      /* observability hook 抛错不影响导航 */
    }
    if (onNavigateHook) {
      try {
        onNavigateHook(url, hookContext);
      } catch {
        /* hook 抛错不影响主流程 */
      }
    }
  };

  window.addEventListener('popstate', fire);

  const oldPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    const res = oldPushState.apply(this, args);
    fire();
    return res;
  };

  const oldReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    const res = oldReplaceState.apply(this, args);
    fire();
    return res;
  };

  function isInternalLink(link: HTMLAnchorElement): boolean {
    return !!(
      link.href &&
      (!link.target || link.target === '_self') &&
      link.origin === location.origin &&
      !link.hasAttribute('download')
    );
  }

  function onClick(e: MouseEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (
      link &&
      link instanceof HTMLAnchorElement &&
      isInternalLink(link) &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.defaultPrevented
    ) {
      e.preventDefault();
      history.pushState(null, '', link.href);
    }
  }
  document.addEventListener('click', onClick);

  // ─── 链接预取（hover / viewport intersect 触发预取 _.rsc）─────────
  // 复用浏览器的 RSC fetch 缓存，导航时立即命中而不是再发请求
  // 减少 50–150ms 客户端导航延迟，对应 next/link 的 prefetch 默认行为
  // 视口预取有硬上限：列表页/首页可能一次渲染几十个链接，不能把低优先级预取消耗成
  // 大量真实 RSC 请求，进而挤占用户交互和应用层限流配额。
  const maxViewportPrefetches = 12;
  let viewportPrefetches = 0;
  const prefetched = new Set<string>();

  function prefetch(href: string, reason: 'intent' | 'viewport' = 'intent'): void {
    if (reason === 'viewport' && viewportPrefetches >= maxViewportPrefetches) return;
    if (prefetched.has(href)) return;
    if (reason === 'viewport') viewportPrefetches += 1;
    prefetched.add(href);
    try {
      const url = new URL(href);
      url.pathname = url.pathname + '_.rsc';
      // 用 prefetch 优先级，不阻塞主流程；浏览器自动 dedupe + LRU
      void fetch(url.toString(), { priority: 'low' } as RequestInit);
    } catch {
      /* invalid URL ignored */
    }
  }

  function onPointerEnter(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (link && link instanceof HTMLAnchorElement && isInternalLink(link)) {
      prefetch(link.href);
    }
  }
  document.addEventListener('pointerenter', onPointerEnter, { capture: true });

  // viewport 内可见时预取 —— 用 IntersectionObserver 监视所有内部链接
  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target instanceof HTMLAnchorElement) {
            if (isInternalLink(entry.target)) prefetch(entry.target.href, 'viewport');
            observer!.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '200px' }
    );
    // 初始扫描 + MutationObserver 跟踪后续 DOM 变化
    const scan = (root: ParentNode) => {
      root.querySelectorAll('a').forEach(a => {
        if (a instanceof HTMLAnchorElement && isInternalLink(a)) observer!.observe(a);
      });
    };
    scan(document);
    const mo = new MutationObserver(records => {
      for (const r of records) {
        r.addedNodes.forEach(n => {
          if (n instanceof Element) scan(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('pointerenter', onPointerEnter, { capture: true });
    observer?.disconnect();
    window.removeEventListener('popstate', fire);
    window.history.pushState = oldPushState;
    window.history.replaceState = oldReplaceState;
  };
}

function createHookContext(
  observability: BrowserObservabilityHandle | null
): ClientEntryHookContext {
  return {
    telemetry: observability
      ? {
          track: observability.track.bind(observability),
          capture: observability.capture.bind(observability),
          measure: observability.measure.bind(observability),
          page: observability.page.bind(observability),
          setUser: observability.setUser.bind(observability),
          flush: observability.flush.bind(observability),
        }
      : NOOP_TELEMETRY,
  };
}

const NOOP_TELEMETRY: ClientEntryTelemetryApi = {
  track() {},
  capture() {},
  measure() {},
  page() {},
  setUser() {},
  flush() {},
};
