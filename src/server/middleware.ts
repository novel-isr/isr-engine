/**
 * 中间件配置
 * 提供通用中间件和开发/生产环境特定中间件
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type RequestHandler, type Request, type Response } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import type { ServerContext } from './types';

/** 用于在 res.locals 上挂 CSP nonce 的 key (Lighthouse csp-xss 审计需要) */
export const CSP_NONCE_LOCAL = 'cspNonce';
/** 用于在 req.headers 上透传 nonce 到 RSC handler 的 header 名 */
export const CSP_NONCE_HEADER = 'x-csp-nonce';

/**
 * 生成 per-request CSP nonce，挂在 res.locals.cspNonce + req.headers['x-csp-nonce']。
 *
 * 作用：
 *   - helmet CSP 用 res.locals.cspNonce 把 `nonce-XXX` 写进 script-src/style-src
 *   - RSC SSR pipeline 从 req header 读 nonce 透传给 React 19 renderToReadableStream，
 *     React 自动给所有 inline script (RSC payload / bootstrap) 打 nonce 属性
 *
 * 必须在 createSecurityMiddleware 之前挂载。
 */
export function createCspNonceMiddleware(): RequestHandler {
  return (req, res, next) => {
    const nonce = randomBytes(16).toString('base64');
    (res.locals as Record<string, unknown>)[CSP_NONCE_LOCAL] = nonce;
    // 透传到下游 RSC handler。Express 不让你直接改 req.headers 类型但运行时可以 set
    (req.headers as Record<string, string>)[CSP_NONCE_HEADER] = nonce;
    next();
  };
}

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
  // dev 关掉 upgrade-insecure-requests（helmet 默认开）—— 不然浏览器把所有
  // http://localhost:3000/* 子请求强制升级到 https，dev server 无 TLS 直接
  // ERR_SSL_PROTOCOL_ERROR。生产留默认（生产必须 HTTPS）。
  // helmet 用 null 禁用单条 directive。
  upgradeInsecureRequests: null,
};

/**
 * 生产环境 CSP 配置
 *
 * scriptSrc 默认走 nonce-based + 'strict-dynamic'：
 *   - 'nonce-XXX'      每请求新生成，React 19 SSR 给所有 inline 脚本自动打 nonce
 *   - 'strict-dynamic' 让 nonce 化的脚本可以加载更多脚本（覆盖 modulepreload 等）
 *   - 'unsafe-inline' 留作向后兼容：CSP3 浏览器看到 nonce 时会自动忽略 'unsafe-inline'，
 *     旧浏览器（CSP2）回退到 'unsafe-inline'。Lighthouse csp-xss 给现代浏览器评分。
 *
 * styleSrc 暂留 'unsafe-inline'：React 19 metadata hoisting 注入的 <style precedence>
 *   也是 inline，nonce 化它们需要更细的 SSR pipeline 改造，本期不做。
 *
 * connectSrc 默认仅 'self'：禁止任意第三方 fetch
 *   需要 cross-origin API（如 Sentry / Mixpanel）：在用户层覆盖此 CSP
 */
const PROD_CSP_BASE = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
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
 *
 * dev 模式仍用 'unsafe-inline'（DEV_CSP）—— HMR 需要。生产模式 nonce-based。
 * 必须在前面挂 createCspNonceMiddleware 才能让 res.locals.cspNonce 存在。
 */
export function createSecurityMiddleware(
  isDev: boolean,
  extraConnectSrc: string[] = []
): RequestHandler {
  if (isDev) {
    const directives = {
      ...DEV_CSP,
      connectSrc: [...DEV_CSP.connectSrc, ...extraConnectSrc],
    };
    return helmet({
      contentSecurityPolicy: { directives },
      strictTransportSecurity: false,
    });
  }
  // helmet directives 值可以是 string 或 (req, res) => string 函数；
  // 函数形式每请求计算 → nonce 一次性使用。helmet 给的类型签名是 node http
  // IncomingMessage/ServerResponse（不是 express Request/Response），所以
  // 这里也用底层签名。
  const nonceFn = (_req: IncomingMessage, res: ServerResponse): string => {
    const locals = (res as ServerResponse & { locals?: Record<string, unknown> }).locals;
    const nonce = locals?.[CSP_NONCE_LOCAL];
    return typeof nonce === 'string' ? `'nonce-${nonce}'` : "'self'";
  };
  const directives = {
    ...PROD_CSP_BASE,
    connectSrc: [...PROD_CSP_BASE.connectSrc, ...extraConnectSrc],
    // script-src: 'self' + 每请求 nonce + 'strict-dynamic'（让 nonce 信任传递给动态加载的脚本）
    //              + 'unsafe-inline' 作 CSP2 回退（CSP3 浏览器看到 nonce 会忽略它）
    scriptSrc: ["'self'", nonceFn, "'strict-dynamic'", "'unsafe-inline'"],
  };
  return helmet({
    contentSecurityPolicy: { directives },
    // dev 关掉 HSTS —— helmet 默认会发 Strict-Transport-Security: max-age=15552000，
    // 浏览器对 localhost 也照吃，导致 dev 时 http:// 被强制升级到 https://。
    // 生产留 helmet 默认（站点必须上 HTTPS）。
    strictTransportSecurity: undefined,
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
 * 在 ops 路由和 Vite middleware 之前执行
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
 * 必须在 ops 路由之后挂载 —— 否则 plugin-rsc 会把 /health 等路径当作页面路由吞掉
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
 * （保留给不需要 ops 路由优先的调用场景）
 */
export function applyMiddlewares(ctx: ServerContext): void {
  applyBaseMiddlewaresWithOptions(ctx);
  mountViteOrStatic(ctx);
}
