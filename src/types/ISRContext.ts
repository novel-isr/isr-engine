import type { ViteDevServer } from 'vite';
import type { RenderModeType } from './ISRConfig';

/**
 * 请求上下文数据（附加字段，engine 自身和中间件可自由扩展）
 */
export interface ISRContextData {
  traceId: string;
  requestId: string;
  /**
   * 多租户：当前请求归属的租户 ID（可选）
   *
   * 当前 engine 自身不消费此字段 —— 由用户中间件按需写入（解析子域名 / 头部 / cookie）。
   * 未来如果支持多租户缓存隔离，会使用此字段作为 cache key 前缀。
   */
  tenantId?: string;
  /** 请求层强制模式（主要用于开发 / 调试） */
  forceMode?: string;
  /** 请求层 fallback 提示 */
  forceFallback?: string;
  /** 是否跳过缓存 */
  bypassCache?: boolean;
  /** Accept-Language 头（供 engine 中间件做语言分流用） */
  acceptLanguage?: string;
  /** Referer */
  referer?: string;
  /** AB 测试开关位 */
  flags?: Record<string, boolean | string>;
  /** SEO 层字段（可由中间件注入） */
  seo?: {
    title?: string;
    description?: string;
    canonical?: string;
    [key: string]: unknown;
  };
  /** 其它业务扩展字段 */
  [key: string]: unknown;
}

/**
 * ISR 请求上下文 —— 跨中间件传递的请求元数据容器
 *
 * plugin-rsc 模式下真正的渲染由 `@vitejs/plugin-rsc` 的 fetch handler 承担，
 * 本类型主要用于：
 *   - ISR 缓存中间件判断命中 / 失效
 *   - 用户中间件链（MiddlewareComposer）的 context
 *   - 错误处理 / 指标采集
 */
export interface ISRContext<T = Record<string, string | string[] | undefined>> {
  req?: {
    headers: T;
    cookies: Record<string, string>;
    query: T;
    userAgent: string;
  };

  res?: {
    statusCode: number;
    headers: T;
  };

  /** 当前请求的 URL */
  url: string;

  /** 最终执行的渲染模式（isr / ssg / ssr） */
  renderModeType: RenderModeType;

  /** Vite dev server 实例（仅开发模式，用于 middleware 链中访问 module graph 等） */
  server?: ViteDevServer;

  /** 错误信息 */
  error?: Error;

  /** 上下文数据 */
  data: ISRContextData;
}
