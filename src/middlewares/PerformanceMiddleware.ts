import { Middleware } from './types';
import { Logger } from '../logger/Logger';

export const performanceMiddleware: Middleware = async (_context, next) => {
  const start = process.hrtime();
  const logger = Logger.getInstance();

  try {
    await next();
  } finally {
    const diff = process.hrtime(start);
    const timeInMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(3);

    // 记录请求处理总耗时
    // 注意：这里使用了 finally，确保即使后续中间件报错也能记录耗时
    logger.info(`[Performance] Request processed in ${timeInMs}ms`);
  }
};
