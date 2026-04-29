/**
 * 中间件配置
 * 提供通用中间件和开发/生产环境特定中间件
 */

import express, { type RequestHandler, type Request, type Response } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import type { ServerContext } from './types';

/**
 * 开发环境 CSP 配置
 */
const DEV_CSP = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'ws:', 'wss:'],
  imgSrc: ["'self'", 'data:', 'https:', 'http:'],
  connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
  fontSrc: ["'self'", 'https:', 'data:'],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'", 'https:', 'data:'],
  frameSrc: ["'self'"],
};

/**
 * 生产环境 CSP 配置
 *
 * scriptSrc 允许 'unsafe-inline'：
 *   RSC SSR 必须内联 bootstrap script + Flight payload；与 Next.js 默认行为一致
 *   要更严格：用 nonce-based CSP（engine 内部支持，需在 ssr.config 设 nonce 提供器）
 *
 * connectSrc 默认仅 'self'：禁止任意第三方 fetch
 *   需要 cross-origin API（如 Sentry / Mixpanel）：在用户层覆盖此 CSP（参见 README）
 */
const PROD_CSP = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'https:', 'data:'],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'", 'https:'],
  frameSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
};

/**
 * 创建安全中间件
 *
 * extraConnectSrc：用户的服务域（来自 ssr.config.ts runtime.services）
 * 自动加入 CSP connect-src，避免浏览器 CSR-fallback / 业务 fetch 被 CSP 挡
 */
export function createSecurityMiddleware(
  isDev: boolean,
  extraConnectSrc: string[] = []
): RequestHandler {
  const baseCsp = isDev ? DEV_CSP : PROD_CSP;
  const directives = {
    ...baseCsp,
    connectSrc: [...baseCsp.connectSrc, ...extraConnectSrc],
  };
  return helmet({
    contentSecurityPolicy: { directives },
  });
}

/**
 * 创建压缩中间件 —— streaming-safe gzip/deflate
 *
 * 策略（行业事实标准）：
 *   - Node 进程内只做 streaming-safe gzip/deflate
 *   - Brotli 放到 CDN / Nginx / Edge 层做，避免 Node 端为追求 br 缓冲整包，破坏 SSR/RSC 流式输出
 *   - HEAD/204/304 / 已压缩 / 小于阈值 → 不压缩
 *
 * 注意：
 *   - text/event-stream 永远不压缩，避免长连接被代理或浏览器缓冲
 *   - 若部署在 nginx/Cloudflare 后面，建议禁用本中间件让边缘做压缩
 */
export function createCompressionMiddleware(
  options: {
    threshold?: number;
    level?: number;
  } = {}
): RequestHandler {
  return compression({
    threshold: options.threshold ?? 1024,
    level: options.level ?? 6,
    filter: (req: Request, res: Response) => {
      const contentType = String(res.getHeader('Content-Type') || '');
      if (contentType.includes('text/event-stream')) {
        return false;
      }
      return compression.filter(req, res);
    },
  });
}

/**
 * 创建 JSON 解析中间件
 */
export function createJsonMiddleware(): RequestHandler {
  return express.json();
}

/**
 * 创建 URL 编码解析中间件
 */
export function createUrlEncodedMiddleware(): RequestHandler {
  return express.urlencoded({ extended: true });
}

/**
 * 创建静态文件中间件（生产环境）
 */
export function createStaticMiddleware(staticDir: string): RequestHandler {
  return express.static(staticDir);
}

/**
 * 前置中间件：安全 / 压缩 / Body 解析
 * 在 admin 路由和 Vite middleware 之前执行
 *
 * 注意：dev 模式**不挂 compression** —— 原因：
 *   - 开发环境响应体不需要压缩（带宽不是瓶颈）
 *   - compression 1.7.x 依赖的 on-headers@1.0.x 与 srvx 0.11+（plugin-rsc 用）
 *     的 writeHead flat-headers 调用不兼容，会把 ["content-type", "text/html"]
 *     1D 数组当作 2D 误读成 `c:o, t:e`，污染 content-type 并导致 ISR 缓存失效
 *   - 生产模式由 cli/start.ts 单独装配，含 compression
 */
export function applyBaseMiddlewares(ctx: ServerContext): void {
  applyBaseMiddlewaresWithOptions(ctx);
}

export function applyBaseMiddlewaresWithOptions(
  ctx: ServerContext,
  compressionOptions: {
    enabled?: boolean;
    threshold?: number;
    level?: number;
  } = {}
): void {
  const { requestHandler, isDev } = ctx;

  requestHandler.disable('x-powered-by');
  requestHandler.use(createSecurityMiddleware(isDev));
  if (!isDev && compressionOptions.enabled !== false) {
    requestHandler.use(
      createCompressionMiddleware({
        threshold: compressionOptions.threshold,
        level: compressionOptions.level,
      })
    );
  }
  requestHandler.use(createJsonMiddleware());
  requestHandler.use(createUrlEncodedMiddleware());
}

/**
 * Vite 开发中间件 / 静态资源服务
 * 必须在 admin 路由之后挂载 —— 否则 plugin-rsc 会把 /health 等路径当作页面路由吞掉
 */
export function mountViteOrStatic(ctx: ServerContext): void {
  const { requestHandler, isDev, viteDevMiddleware } = ctx;

  if (isDev && viteDevMiddleware) {
    requestHandler.use(viteDevMiddleware.middlewares);
  } else if (!isDev) {
    requestHandler.use(createStaticMiddleware('./dist/client'));
  }
}

/**
 * 向后兼容入口：一次性按老顺序挂载所有中间件
 * （保留给不需要 admin 路由优先的调用场景）
 */
export function applyMiddlewares(ctx: ServerContext): void {
  applyBaseMiddlewaresWithOptions(ctx);
  mountViteOrStatic(ctx);
}
