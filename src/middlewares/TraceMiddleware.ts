import { randomUUID } from 'crypto';
import { Middleware } from './types';
import { requestContext } from '../context/RequestContext';
import { Logger } from '../logger/Logger';

export const traceMiddleware: Middleware = async (context, next) => {
  // 2. 生成或获取 ID
  // 优先使用传入的 ID (例如来自上游 Nginx 或 Gateway)，否则生成新的
  const traceId = (context.data?.traceId as string) || `trace-${randomUUID()}`;
  const requestId = (context.data?.requestId as string) || `req-${randomUUID()}`;

  // 1. 确保 data 对象存在并初始化
  if (!context.data) {
    context.data = {
      traceId,
      requestId,
    };
  } else {
    context.data.traceId = traceId;
    context.data.requestId = requestId;
  }

  // 4. 启动 ALS 上下文，并执行后续逻辑
  // 直接使用 context.data 作为 ALS 的 Store，实现数据共享
  // 这样后续中间件修改 context.data (如添加 flags)，ALS 中也能获取到
  await requestContext.run(context.data, async () => {
    const logger = Logger.getInstance();
    logger.debug(`[Middleware] Trace initialized: ${traceId}`);
    await next();
  });
};
