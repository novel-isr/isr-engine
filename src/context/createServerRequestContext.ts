/**
 * createServerRequestContext —— engine 入口处构造 RequestContext 的统一工厂。
 *
 * 两个入口（cli/start.ts production server + server/manager.ts dev/programmatic）
 * 都通过这里构造 ctx，保证：
 *   - traceId / requestId / anonId 三个 ID 的生成逻辑只有一份
 *   - anonId 缺失时的 Set-Cookie 落点只有一处
 *   - cookies map 解析、X-Request-Id 解析、W3C traceparent 解析的优先级一致
 *
 * 出参 needsAnonCookie：调用方据此在 res 上 appendHeader('Set-Cookie', ...)。
 * 必须在 cache lookup 之前 set，但 cache 层会把 anon 这一条从 captured.headers 里
 * 剥掉再入缓存（见 plugin/isrCacheMiddleware.ts），保证缓存内容 user-agnostic。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ISRContextData } from '../types/ISRContext';
import { parseCookieHeader } from '../utils/cookie';

/** anonId cookie 名称 —— engine 全局常量，避免散落字符串。 */
export const ANON_COOKIE_NAME = 'anon';

/** anonId cookie 有效期（秒）。1 年；浏览器侧最大也只能撑到这个量级。 */
export const ANON_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface CreatedRequestContext {
  /** 直接喂给 requestContext.run() 的 ISRContextData 实例 */
  data: ISRContextData;
  /** true 表示 anonId 是本次新生成的，调用方需要把 Set-Cookie 写到响应头 */
  needsAnonCookie: boolean;
}

/**
 * 从 IncomingMessage 构造 ISRContextData。
 *
 * 优先级：
 *   - traceId: W3C traceparent header → 自生成 UUID
 *   - requestId: X-Request-Id header → 自生成 UUID
 *   - anonId: cookie `anon` → 自生成 UUID（needsAnonCookie=true）
 *
 * userId / sessionToken / sessionUser 留空 —— 业务侧 beforeRequest hook 写入。
 */
export function createServerRequestContext(req: IncomingMessage): CreatedRequestContext {
  const rawCookie = req.headers['cookie'];
  const cookieHeader = Array.isArray(rawCookie)
    ? rawCookie.join('; ')
    : typeof rawCookie === 'string'
      ? rawCookie
      : '';
  const cookies = parseCookieHeader(cookieHeader);

  const headerReqId = req.headers['x-request-id'];
  const headerTraceparent = req.headers['traceparent'];

  const existingAnon = cookies[ANON_COOKIE_NAME];
  const anonId = existingAnon || randomUUID();
  const needsAnonCookie = !existingAnon;

  // 把新生成的 anonId 回填进 cookies map —— 让本次请求里下游 middleware
  // （AB / SEO / telemetry 等）能从同一来源读到，行为跟"cookie 已存在的请求"一致
  if (needsAnonCookie) {
    cookies[ANON_COOKIE_NAME] = anonId;
  }

  return {
    data: {
      traceId:
        typeof headerTraceparent === 'string' && headerTraceparent
          ? headerTraceparent
          : randomUUID(),
      requestId: typeof headerReqId === 'string' && headerReqId ? headerReqId : randomUUID(),
      anonId,
      cookies,
    },
    needsAnonCookie,
  };
}

/**
 * 把 anonId Set-Cookie 头写进响应。
 *
 * Set-Cookie 写在 cache lookup 之前（live 响应 client 必收到），但 cache 层
 * 在 captureAndStore 里会从存储的 headers 里剥掉 anon 这条 —— cache entry 永远
 * user-agnostic，可以被多个 anonId 命中（cache key 走 ctx.experiments digest 隔离）。
 *
 * 参数：HttpOnly=false 让客户端 SDK 能读取做曝光上报；SameSite=Lax 让 GET 请求
 * 跨站跳转也带（搜索引擎结果点击进来不会丢 anonId）；Path=/ 全站共享。
 * Secure 不强制 —— dev http 也要工作；生产 HTTPS 由 reverse proxy 自动加 Secure 标记
 * 不在 engine 侧加。
 *
 * @param cookieDomain 可选 `Domain` 属性。子域分发部署（www.x / admin.x / api.x）
 *   时设 `.your-domain.com`，让浏览器把 anon cookie 自动带到所有子域 ——
 *   SSR 在 www 写、admin-server 在 api 读、客户端 SDK 在 www 读，都能拿到。
 *   单一域名部署时留空，浏览器只把 cookie 关联到当前 host。
 */
export function applyAnonCookie(res: ServerResponse, anonId: string, cookieDomain?: string): void {
  const parts = [
    `${ANON_COOKIE_NAME}=${anonId}`,
    `Max-Age=${ANON_COOKIE_MAX_AGE_SECONDS}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
  res.appendHeader('Set-Cookie', parts.join('; '));
}
