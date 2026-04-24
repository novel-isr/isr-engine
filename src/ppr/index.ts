/**
 * Partial Prerendering (PPR) —— 基于 React 19 `prerender` + `resumeAndPrerender` 的接入层
 *
 * ⚠️ 实验性：本模块 API 已实现，但**触发 PPR 行为需要 React canary**：
 *   - 真 PPR 需要 `React.unstable_postpone()` 主动中断渲染
 *   - React 19.2 **stable** 没暴露此 API（内部代码路径已有，等下个版本暴露）
 *   - 升级到 React canary：pnpm add react@canary react-dom@canary
 *   - 或等 React 19.3+ 公开 postpone() API
 *
 * 工作模型（postpone 可用后）：
 *   1. **构建期** prerender(<App/>)：渲染到 postpone() 处停下
 *      - 返回 { prelude: ReadableStream（静态 shell）, postponed: 序列化状态 }
 *      - prelude 写 dist；postponed 写 .ppr.json
 *   2. **请求期** resume(<App/>, postponed)：
 *      - 立即流 prelude → 浏览器拿静态壳（TTFB ≈ 静态站）
 *      - 续渲动态部分 → 追加到同一 HTTP 流
 *
 * 当前覆盖：
 *   - prerenderShell / resumeShell：薄包装 react-dom/static.edge
 *   - serializePostponed / deserializePostponed：postponed 持久化
 *
 * 未做（等 postpone() 稳定后再做的深度集成）：
 *   - 'ppr' 路由 mode + 构建期自动产出 .ppr.json
 *   - 与 ISR cache 的 prelude 复用（避免每次都走 prerender）
 *   - plugin-rsc 的 RSC 边界识别
 */
import type { ReactNode } from 'react';

interface PrerenderResult {
  prelude: ReadableStream<Uint8Array>;
  postponed: unknown;
}

interface PrerenderOptions {
  /** 客户端水合用 bootstrap 脚本（plugin-rsc 注入的） */
  bootstrapScriptContent?: string;
  nonce?: string;
}

interface StaticEdge {
  prerender(
    children: ReactNode,
    options?: { bootstrapScriptContent?: string; nonce?: string; signal?: AbortSignal }
  ): Promise<{ prelude: ReadableStream<Uint8Array>; postponed: unknown }>;
  resumeAndPrerender(
    children: ReactNode,
    postponed: unknown,
    options?: { nonce?: string }
  ): Promise<{ prelude: ReadableStream<Uint8Array>; postponed: unknown }>;
}

/**
 * 加载 react-dom/static.edge
 *
 * 注意：本模块只能在 SSR 环境（无 react-server condition）调用，
 * 不能在 RSC 组件代码里 import —— React 在 react-server 条件下会主动报错。
 * 用户的 build script / SSR entry 调用时，是普通 Node ESM，可直接 import。
 */
let staticEdgeCache: StaticEdge | null = null;
async function loadStaticEdge(): Promise<StaticEdge> {
  if (staticEdgeCache) return staticEdgeCache;
  staticEdgeCache = (await import('react-dom/static.edge')) as unknown as StaticEdge;
  return staticEdgeCache;
}

/**
 * 构建期：把 React 树渲染到第一个 Suspense 边界停下
 *
 *   const { prelude, postponed } = await prerenderShell(<App />, { bootstrapScriptContent });
 *   await fs.writeFile('dist/shell/index.html', await streamToText(prelude));
 *   await fs.writeFile('dist/shell/index.ppr.json', serializePostponed(postponed));
 */
export async function prerenderShell(
  children: ReactNode,
  options: PrerenderOptions = {}
): Promise<PrerenderResult> {
  const { prerender } = await loadStaticEdge();
  const result = await prerender(children, {
    bootstrapScriptContent: options.bootstrapScriptContent,
    nonce: options.nonce,
  });
  return { prelude: result.prelude, postponed: result.postponed };
}

/**
 * 请求期：根据 postponed 状态续渲动态部分
 *
 *   const stream = await resumeShell(<App />, postponed, { nonce });
 *   return new Response(stream, { headers: { 'content-type': 'text/html' }});
 */
export async function resumeShell(
  children: ReactNode,
  postponed: unknown,
  options: { nonce?: string } = {}
): Promise<ReadableStream<Uint8Array>> {
  const { resumeAndPrerender } = await loadStaticEdge();
  const result = await resumeAndPrerender(children, postponed, {
    nonce: options.nonce,
  });
  return result.prelude;
}

/**
 * 把 postponed 状态序列化为 JSON 字符串（持久化用）
 *
 * postponed 是 React 内部对象（含 Promise / Symbol 等不可 JSON 化的字段）；
 * React 用结构化克隆兼容的 plain object 表示，因此 JSON 化通常 OK；
 * 失败时抛错，由调用方决定降级策略。
 */
export function serializePostponed(postponed: unknown): string {
  return JSON.stringify(postponed);
}

export function deserializePostponed(serialized: string): unknown {
  return JSON.parse(serialized);
}

/** 把 ReadableStream 收成 string，仅用于 dev / 测试 */
export async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
