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
// @ts-expect-error - 虚拟模块由 plugin-rsc 注入
import assetsManifest from 'virtual:vite-rsc/assets-manifest';

/** 收集 manifest 里所有唯一的 CSS 链接（client + server 两边）—— csr-shell 注入样式用 */
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
  formState?: ReactFormState;
  returnValue?: { ok: boolean; data: unknown };
}

/** csr-shell fallback 页面的内联样式（自包含，不依赖任何外部 stylesheet）*/
const CSR_SHELL_STYLES = `
  .csr-shell-body {
    background: #1a1a1a;
    color: #bbb;
    font: 14px system-ui, sans-serif;
    padding: 48px 24px;
    text-align: center;
    margin: 0;
  }
  .csr-shell-hint {
    max-width: 520px;
    margin: 0 auto;
    opacity: 0.7;
  }
`;

function standardizePreloadHints(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';
  const preloadStylesheetAsRe =
    /(<link\b(?=[^>]*\brel=(["'])preload\2)(?=[^>]*\bas=(["'])stylesheet\3)[^>]*?)\bas=(["'])stylesheet\4/gi;

  const normalize = (html: string) =>
    html.replace(preloadStylesheetAsRe, (_match, prefix, _relQuote, _asQuote, asAttrQuote) => {
      return `${prefix}as=${asAttrQuote}style${asAttrQuote}`;
    });

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = carry + decoder.decode(chunk, { stream: true });
        const splitAt = Math.max(0, text.lastIndexOf('<link'));
        const ready = text.slice(0, splitAt);
        carry = text.slice(splitAt);
        if (ready) controller.enqueue(encoder.encode(normalize(ready)));
      },
      flush(controller) {
        const text = carry + decoder.decode();
        if (text) controller.enqueue(encoder.encode(normalize(text)));
      },
    })
  );
}

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
    return React.use(payload).root;
  }

  const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent('index');

  let htmlStream: ReadableStream<Uint8Array>;
  let status: number | undefined;
  let csrShellFallback = false;

  try {
    if (options.forceCsrShell) throw new Error('forceCsrShell debug flag');
    htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent: options.debugNojs ? undefined : bootstrapScriptContent,
      nonce: options.nonce,
      formState: options.formState,
    });
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
          <div className='csr-shell-hint'>服务端暂时不可用，正在尝试客户端加载…</div>
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
