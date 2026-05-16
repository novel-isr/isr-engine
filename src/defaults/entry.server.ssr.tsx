/**
 * 默认 SSR 环境入口（engine 内置）
 *
 * 自动启用条件：用户项目 `<root>/src/entry.ssr.tsx` 不存在时，由 createIsrPlugin
 * 把 plugin-rsc 的 ssr 入口指向本文件。
 *
 * 这是一段纯模板代码 —— 接收 Flight 流，调用 react-dom/server.edge 输出 HTML，
 * 用 rsc-html-stream 把 Flight 内联到 HTML 末尾以供浏览器水合。
 *
 * 用户**不需要**在自己的项目里写这个文件；只有当你需要在 SSR 环境里自定义
 * payload 类型、注入 nonce、定制 fallback HTML 等场景，才在 `<root>/src/`
 * 下放一个同名文件覆盖此默认实现。
 */
import { createFromReadableStream } from '@vitejs/plugin-rsc/ssr';
import * as React from 'react';
import type { ReactFormState } from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server.edge';
import { injectRSCPayload } from 'rsc-html-stream/server';
import type { IntlPayload } from './runtime/seo-runtime';
import { standardizePreloadHints } from './runtime/standardize-preload-hints';
import { setClientI18n } from '../runtime/i18n-store';
import { HydrationShell } from './runtime/hydration-shell';
// @ts-expect-error - 虚拟模块由 plugin-rsc 注入
import assetsManifest from 'virtual:vite-rsc/assets-manifest';

/** 收集 manifest 里所有唯一的 CSS 链接（client + server 两边）。
 *
 * 只在 csr-shell fallback 路径使用 —— SSR 抛错后我们不知道原本应该走哪条路由的
 * CSS，所以全量注入兜底。
 *
 * 正常 SSR 路径不再走这里：plugin-rsc 天然只为本次渲染用到的 chunk emit
 * `<link rel=preload as=stylesheet>`（已经是 scoped-by-route），engine 的
 * standardize-preload-hints stream rewriter 在出流时把这些 preload 升级成
 * `<link rel=stylesheet data-precedence=...>` 让它们成为 blocking stylesheet，
 * 既消除 LCP element render delay，又不会过度注入跨路由 CSS。
 */
function collectAllCss(): string[] {
  const set = new Set<string>();
  const m = assetsManifest as {
    clientReferenceDeps?: Record<string, { css?: string[] }>;
    serverResources?: Record<string, { css?: string[] }>;
  };
  for (const group of [m?.clientReferenceDeps, m?.serverResources]) {
    if (!group) continue;
    for (const id of Object.keys(group)) {
      for (const href of group[id].css ?? []) set.add(href);
    }
  }
  return Array.from(set);
}

interface DefaultRscPayload {
  root: React.ReactNode;
  intl?: IntlPayload | null;
  formState?: ReactFormState;
  returnValue?: { ok: boolean; data: unknown };
}

/** csr-shell fallback 页面的内联样式（自包含，不依赖任何外部 stylesheet）*/
const CSR_SHELL_STYLES = `
  :root { color-scheme: dark; }
  .csr-shell-body {
    margin: 0;
    background: #111418;
    color: #e7edf4;
    font: 14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .csr-shell-page {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 32px 20px;
  }
  .csr-shell-card {
    width: min(520px, 100%);
    padding: 28px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: #171b21;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
  }
  .csr-shell-badge {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    border: 1px solid rgba(125, 211, 252, 0.24);
    border-radius: 999px;
    background: rgba(14, 165, 233, 0.12);
    color: #7dd3fc;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
  }
  .csr-shell-title {
    margin: 18px 0 8px;
    color: #f8fafc;
    font-size: clamp(24px, 4vw, 34px);
    line-height: 1.15;
    letter-spacing: 0;
  }
  .csr-shell-copy {
    margin: 0;
    color: #aab4c1;
    line-height: 1.7;
  }
  .csr-shell-grid {
    display: grid;
    gap: 10px;
    margin-top: 22px;
  }
  .csr-shell-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
  }
  .csr-shell-row span:first-child { color: #8894a3; }
  .csr-shell-row span:last-child { color: #f8fafc; font-weight: 700; text-align: right; }
  .csr-shell-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    margin-top: 22px;
    padding: 0 16px;
    border-radius: 6px;
    background: #f97316;
    color: #111418;
    font-weight: 800;
    text-decoration: none;
  }
  .csr-shell-action:focus-visible {
    outline: 2px solid #fed7aa;
    outline-offset: 2px;
  }
`;

// preload-hint 改写实现独立到 ./runtime/standardize-preload-hints.ts，可单测。

export interface RenderHtmlOptions {
  formState?: ReactFormState;
  nonce?: string;
  /** true 时跳过 bootstrap 脚本和 RSC 内联 payload，模拟禁用 JS 场景 */
  debugNojs?: boolean;
  /** 强制走 csr-shell 兜底（调试用 —— ?__csr-shell=1 触发） */
  forceCsrShell?: boolean;
  /** 浏览器可访问的 API base —— 注入到 csr-shell 让 CSR fallback 能 fetch */
  apiBaseUrl?: string;
}

export interface RenderHtmlResult {
  stream: ReadableStream<Uint8Array>;
  status?: number;
  /** 是否启用了 csr-shell fallback（SSR 渲染崩溃时由本模块自动设置） */
  csrShellFallback?: boolean;
}

export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>,
  options: RenderHtmlOptions = {}
): Promise<RenderHtmlResult> {
  const [rscStream1, rscStream2] = rscStream.tee();

  let payload: Promise<DefaultRscPayload> | undefined;

  function SsrRoot() {
    payload ??= createFromReadableStream<DefaultRscPayload>(rscStream1);
    const data = React.use(payload);
    setClientI18n(data.intl);
    return data.root;
  }

  const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent('index');

  let htmlStream: ReadableStream<Uint8Array>;
  let status: number | undefined;
  let csrShellFallback = false;

  try {
    if (options.forceCsrShell) throw new Error('forceCsrShell debug flag');
    htmlStream = await renderToReadableStream(
      <HydrationShell>
        <SsrRoot />
      </HydrationShell>,
      {
        bootstrapScriptContent: options.debugNojs ? undefined : bootstrapScriptContent,
        nonce: options.nonce,
        formState: options.formState,
      }
    );
  } catch (err) {
    // FallbackChain 末端 csr-shell：SSR 渲染抛异常 → 不出 5xx 白屏，
    // 改返回最小壳 HTML + self.__NO_HYDRATE=1，让浏览器走 createRoot 自救
    csrShellFallback = true;
    status = 200; // 我们成功交付了壳；客户端去尝试 _.rsc 自愈
    const reason = err instanceof Error ? err.message : err;
    if (options.forceCsrShell) {
      console.info('[isr-engine] CSR shell fallback requested by debug flag');
    } else {
      console.warn('[isr-engine] SSR render failed → falling back to csr-shell:', reason);
    }
    // 注入用户的全部 client CSS chunks 到 csr-shell —— 否则 CSR fallback 渲染丢样式
    const cssLinks = collectAllCss();
    htmlStream = await renderToReadableStream(
      <html lang='zh-CN'>
        <head>
          <meta charSet='utf-8' />
          <title>正在加载…</title>
          {cssLinks.map(href => (
            <link key={href} rel='stylesheet' href={href} />
          ))}
          <style dangerouslySetInnerHTML={{ __html: CSR_SHELL_STYLES }} />
        </head>
        <body className='csr-shell-body'>
          <noscript>需要启用 JavaScript 以加载页面。</noscript>
          <div className='csr-shell-page'>
            <main className='csr-shell-card' role='status' aria-live='polite'>
              <span className='csr-shell-badge'>CSR fallback</span>
              <h1 className='csr-shell-title'>服务端暂时不可用</h1>
              <p className='csr-shell-copy'>
                已交付客户端自救壳，正在加载前端资源并尝试恢复页面。刷新后会重新请求服务端渲染。
              </p>
              <div className='csr-shell-grid' aria-label='降级状态'>
                <div className='csr-shell-row'>
                  <span>Render strategy</span>
                  <span>csr-shell</span>
                </div>
                <div className='csr-shell-row'>
                  <span>Cache policy</span>
                  <span>not cached</span>
                </div>
              </div>
              <a className='csr-shell-action' href='/'>
                返回首页
              </a>
            </main>
          </div>
        </body>
      </html>,
      {
        bootstrapScriptContent:
          'self.__NO_HYDRATE=1;' +
          (options.apiBaseUrl ? `self.__API_BASE__=${JSON.stringify(options.apiBaseUrl)};` : '') +
          (options.debugNojs ? '' : bootstrapScriptContent),
        nonce: options.nonce,
      }
    );
  }

  let responseStream: ReadableStream<Uint8Array> = htmlStream;
  if (!options.debugNojs && !csrShellFallback) {
    // 正常路径才内联 Flight payload（csr-shell 路径下 Flight 已损坏，注入会让客户端反序列化崩）
    responseStream = responseStream.pipeThrough(
      injectRSCPayload(rscStream2, { nonce: options.nonce })
    );
  }

  responseStream = standardizePreloadHints(responseStream);

  return { stream: responseStream, status, csrShellFallback };
}
