/**
 * `novel-isr test-fallback-local` —— 本地 SSR → SPA fallback 验证代理
 *
 * 行为是 nginx `error_page 5xx = @spa_fallback` 的功能等价物，
 * 让开发者**不装 nginx**也能在本地复现整条降级链路。
 *
 * 监听 :PORT（默认 8080）：
 *   - /assets/*, /covers/*, /favicon.ico, /logo.svg → dist/client/ 静态返回
 *   - /api/*                                       → 反代到 mock/upstream API（默认 :3001）
 *   - 其它                                          → 反代到 SSR（默认 :3000）；
 *                                                     5xx 或 connect refused → 切 dist/spa/index.html
 *                                                     兜底响应附带 `x-fallback: spa` 头
 *
 * 用法：
 *   pnpm build
 *   pnpm --filter mock-server start              # :3001
 *   novel-isr start                              # :3000  SSR
 *   novel-isr test-fallback-local                # :8080  ← 用户访问这个
 *   open http://localhost:8080/                  # → 看到 SSR 渲染
 *   kill <ssr pid>; reload                       # → 自动看到橙色 banner + SPA 兜底
 *   重启 SSR; reload                             # → 自动切回 SSR
 *
 * 生产环境**不需要**这个命令 —— 用 nginx 的 error_page 即可。
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { logger } from '@/logger';

export interface FallbackProxyOptions {
  /** 监听端口（用户访问此处） */
  port: string;
  /** SSR 上游端口（novel-isr start 监听的） */
  ssrPort: string;
  /** API 上游端口（mock-server / 真后端） */
  apiPort: string;
  /** dist 根目录（绝对或相对路径，相对 cwd） */
  dist: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

interface UpstreamTarget {
  host: string;
  port: number;
}

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: UpstreamTarget,
  onUpstreamError?: (err: Error) => void
): void {
  const handleErr = (err: Error): void => {
    if (onUpstreamError) onUpstreamError(err);
    else sendError(res, 502, err.message);
  };
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${target.host}:${target.port}` },
    },
    upRes => {
      const code = upRes.statusCode || 502;
      if (code >= 500 && onUpstreamError) {
        upRes.resume();
        onUpstreamError(new Error(`upstream ${code}`));
        return;
      }
      res.writeHead(code, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', handleErr);
  req.pipe(upstream);
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientRoot: string
): Promise<void> {
  const url = new URL(req.url || '/', 'http://x');
  const filePath = join(clientRoot, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(clientRoot)) {
    sendError(res, 403, 'forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not file');
    const buf = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    });
    res.end(buf);
  } catch {
    sendError(res, 404, 'not found');
  }
}

async function serveSpaShell(res: http.ServerResponse, spaShell: string): Promise<void> {
  try {
    const html = await readFile(spaShell, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-fallback': 'spa' });
    res.end(html);
  } catch {
    sendError(res, 500, `SPA shell not found at ${spaShell} — run \`pnpm build\` first`);
  }
}

function sendError(res: http.ServerResponse, code: number, msg: string): void {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${code} ${msg}\n`);
}

/**
 * 创建 fallback 路由 handler（与 listen 解耦），便于单测直接挂到 ephemeral port 上
 * 验证三种分支（static / api proxy / ssr proxy + spa fallback）。
 */
export function createFallbackRequestHandler(options: FallbackProxyOptions): http.RequestListener {
  const distRoot = resolve(process.cwd(), options.dist);
  const clientRoot = join(distRoot, 'client');
  const spaShell = join(distRoot, 'spa', 'index.html');
  const ssr: UpstreamTarget = { host: '127.0.0.1', port: parseInt(options.ssrPort, 10) };
  const api: UpstreamTarget = { host: '127.0.0.1', port: parseInt(options.apiPort, 10) };

  return (req, res) => {
    const path = (req.url || '/').split('?')[0];

    if (
      path.startsWith('/assets/') ||
      path.startsWith('/covers/') ||
      path === '/favicon.ico' ||
      path === '/logo.svg'
    ) {
      void serveStatic(req, res, clientRoot);
      return;
    }

    if (path.startsWith('/api/')) {
      proxyRequest(req, res, api);
      return;
    }

    proxyRequest(req, res, ssr, err => {
      logger.warn('[fallback]', `SSR 失败 (${err.message}) → 切换 SPA shell: ${path}`);
      void serveSpaShell(res, spaShell);
    });
  };
}

export function startFallbackProxy(options: FallbackProxyOptions): http.Server {
  const distRoot = resolve(process.cwd(), options.dist);
  const spaShell = join(distRoot, 'spa', 'index.html');
  const ssrPort = parseInt(options.ssrPort, 10);
  const apiPort = parseInt(options.apiPort, 10);
  const listenPort = parseInt(options.port, 10);

  const server = http.createServer(createFallbackRequestHandler(options));

  server.listen(listenPort, () => {
    logger.success('[CLI]', `本地 fallback proxy 已启动: http://localhost:${listenPort}`);
    logger.info('[CLI]', `  → SSR upstream  : http://127.0.0.1:${ssrPort}`);
    logger.info('[CLI]', `  → API upstream  : http://127.0.0.1:${apiPort}`);
    logger.info('[CLI]', `  → 5xx fallback  : ${spaShell}`);
    logger.info(
      '[CLI]',
      `提示：杀掉 SSR 进程 + 浏览器 reload，可看到自动切到 SPA shell（响应头 x-fallback: spa）`
    );
  });

  return server;
}
