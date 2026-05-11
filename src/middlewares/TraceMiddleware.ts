import { randomUUID } from 'crypto';
import { Middleware } from './types';
import { requestContext } from '../context/RequestContext';
import { Logger } from '../logger/Logger';

/**
 * W3C trace-context (traceparent) 解析
 *
 * 格式：`00-<trace-id:32 hex>-<parent-id:16 hex>-<flags:2 hex>`
 * 标准：https://www.w3.org/TR/trace-context/
 *
 * 支持版本：只接受 `00`（当前规范唯一定义的版本）。其他版本按未识别丢弃。
 * 解析失败返回 null —— 调用方走生成新 ID 的路径。
 */
export function parseTraceparent(
  raw: string | undefined
): { traceId: string; parentId: string; flags: string } | null {
  if (!raw) return null;
  const parts = raw.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== '00') return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(parentId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  // trace-id = 全 0 或 parent-id = 全 0 均为非法（规范要求）
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

/**
 * 优先级读取 traceId：
 *   1) W3C traceparent 头（业界标准，OTel/Datadog/Honeycomb 全支持）
 *   2) context.data.traceId（上游框架已解析好的）
 *   3) X-Request-Id（Heroku/Nginx/Kubernetes ingress 常用）
 *   4) 自生成 `trace-<uuid>`（结尾兜底）
 */
export const traceMiddleware: Middleware = async (context, next) => {
  const headers = (context.req?.headers ?? {}) as Record<string, string | string[] | undefined>;

  const tp = parseTraceparent(
    typeof headers.traceparent === 'string' ? headers.traceparent : undefined
  );

  const upstreamTraceId =
    tp?.traceId ||
    (context.data?.traceId as string | undefined) ||
    (typeof headers['x-request-id'] === 'string' ? (headers['x-request-id'] as string) : undefined);

  const traceId = upstreamTraceId || `trace-${randomUUID()}`;
  const requestId = (context.data?.requestId as string) || `req-${randomUUID()}`;
  // anonId 正常路径由 engine express 入口 createServerRequestContext 写入；走到这里
  // 还为空，说明是 dev / 测试 / 直接走 MiddlewareComposer 的场景，兜底生成一个 UUID，
  // 保证 RequestContext 的 anonId 不变量「永远非空」。
  const anonId = (context.data?.anonId as string) || randomUUID();

  if (!context.data) {
    context.data = {
      traceId,
      requestId,
      anonId,
    };
  } else {
    context.data.traceId = traceId;
    context.data.requestId = requestId;
    context.data.anonId = anonId;
  }

  await requestContext.run(context.data, async () => {
    const logger = Logger.getInstance();
    logger.debug(
      `[Middleware] Trace initialized: ${traceId}${tp ? ' (from W3C traceparent)' : ''}`
    );
    await next();
  });
};
