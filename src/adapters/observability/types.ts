/**
 * 可观测性 SDK 适配器的统一形状
 *
 * 思路：每个 SDK（Sentry / Datadog / OTel）都长得很像 —— start span / end span / capture
 * exception。我们抽象出一个通用形状，对各 SDK 各写一个薄 adapter，让用户
 *
 *   import { sentryServerHooks } from '@novel-isr/engine/adapters/observability';
 *
 * 一行接入，无需重写 hook 模板代码。
 */

/** 服务端 SDK 的最小契约 —— 我们只用这 3 个能力 */
export interface ServerObservabilitySdk {
  /** 开 span：返回的对象由 endSpan 闭合 */
  startSpan(opts: { op: 'http.server'; name: string; traceId: string }): unknown;
  /** 结束 span，传入响应状态码 */
  endSpan(span: unknown, opts: { status: number; durationMs: number }): void;
  /** 上报异常 */
  captureException(err: unknown, ctx: { traceId: string; url?: string }): void;
}

/** 浏览器 SDK 的最小契约 */
export interface ClientObservabilitySdk {
  /** 应用启动前调用一次 —— 用于 SDK init / web-vitals 注册 */
  init(): void;
  /** 客户端导航发生时 */
  trackNavigation?(url: URL): void;
  /** Server Action 失败 */
  captureActionError(err: unknown, actionId: string): void;
}
