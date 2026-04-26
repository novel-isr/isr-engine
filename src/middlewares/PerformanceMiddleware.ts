import { Middleware } from './types';
import { Logger } from '../logger/Logger';

/**
 * 性能观测中间件 —— 记录中间件链的总耗时。
 *
 * 产出两路信号：
 *   1) `logger.info('[Performance] ...')`：开发排错用
 *   2) `context.res.headers['X-Render-Ms']`：注入到响应头供前端 / 网关读取
 *      （例如 Browser performance.mark、Grafana Nginx 日志抓取 $upstream_http_x_render_ms）
 *
 * 注意：ISRContext.res.headers 是上下文级的 header 袋。能否真正走到 wire 取决于
 * 上层 Express 适配把这些 header 真正 apply 到 ServerResponse。框架默认适配已做了。
 */
export const performanceMiddleware: Middleware = async (context, next) => {
  const start = process.hrtime();
  const logger = Logger.getInstance();

  try {
    await next();
  } finally {
    const diff = process.hrtime(start);
    const timeInMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(3);

    logger.info(`[Performance] Request processed in ${timeInMs}ms`);

    if (context.res) {
      // ISRContext.res.headers 是 key→value 形状的通用头袋，类型上允许写入字符串
      const headers = context.res.headers as unknown as Record<string, string>;
      headers['X-Render-Ms'] = timeInMs;
    }
  }
};
