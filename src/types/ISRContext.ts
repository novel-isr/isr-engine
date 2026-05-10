import type { ViteDevServer } from 'vite';
import type { RenderModeType } from './ISRConfig';

/**
 * 请求上下文数据 —— engine 内部 + 业务 hook 写入的字段。
 *
 * 设计原则：只放"被多处消费"的字段。一次性的（如 acceptLanguage / referer）engine
 * 直接读 req.headers，不复制到 ctx；trace 快照同样直接读 req.headers，不依赖 ctx。
 *
 * 已删除的字段（声明但无消费者，纯死代码）：
 *   - forceMode / forceFallback / bypassCache：dev 调试 URL 参数曾计划走这里，
 *     现在 plugin-rsc / engine cache 都直接读 query string，没人读这三个字段
 *   - seo：声明了但 engine SEO 路径用 PageSeoMeta（独立类型），不走这里
 *   - acceptLanguage / referer：曾写到 ctx 给 trace 用，trace 改读 req.headers 后
 *     这两个 ctx 字段就再无消费者
 */
export interface ISRContextData {
  /** W3C trace-context traceparent 或自生成 UUID；用作 cross-service 追踪 + admin 排障索引 */
  traceId: string;
  /** 单服务的请求 ID；写到响应头 x-request-id 给客户端 / 客户端日志关联用 */
  requestId: string;
  /** 已登录用户 ID（业务侧 beforeRequest 写入，Server Component / Server Action 消费） */
  userId?: string;
  /**
   * 鉴权 token（cookie / header 解出）；engine 不读不写，业务侧 Server Action
   * 透传给后端 API 做鉴权。
   */
  sessionToken?: string;
  /**
   * 用户 session 摘要（displayName / handle / avatar 等）。业务侧 Server Component
   * 直接读这里来拼 UI，避免每个 RSC 重新拉一次 user info。
   */
  sessionUser?: { userId?: string; displayName?: string; handle?: string; [key: string]: unknown };
  /**
   * 解析后的 Cookie 表 —— 由 engine 入口中间件 parseCookieHeader(req.headers.cookie)
   * 写入。Server Component 通过 `getRequestContext()?.cookies?.<name>` 读取，
   * 让"locale / 实验位"这类 SSR 首屏就要决定的偏好不依赖 client mount。
   */
  cookies?: Record<string, string>;
  /** A/B 测试开关位（engine ABVariantMiddleware 写入；getVariant() 读） */
  flags?: Record<string, boolean | string>;
  /** 其它业务扩展字段（engine 不消费） */
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
