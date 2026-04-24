/**
 * SSG 爬虫 —— 构建后爬取 RSC fetch handler，产出静态 HTML 到 dist/client
 *
 * 设计目标：
 *   - 仅依赖 Web Fetch API（Request/Response），与底层 handler 实现解耦
 *   - 接受 `fetch(request) => Promise<Response>` 契约（即 @vitejs/plugin-rsc
 *     为 src/entry.server.tsx 默认导出定义的签名）
 *   - 并发控制：默认 3，自写极简 Promise 闸门，无额外依赖
 *   - 写盘策略：
 *       '/'       → dist/client/index.html
 *       '/about'  → dist/client/about/index.html
 *     这样 Express `static` 中间件就能直接命中，无需额外路由
 *
 * 鲁棒性（v2.1 起）：
 *   过去版本对单页失败的处理是「日志打一行 + continueOnError 默认 true」——
 *   这意味着大型 SSG 集（1000+ 路由）里某几页 flake 就会悄悄写出残缺产物，
 *   生产部署后用户访问这些页直接 404。
 *   现在加三道闸：
 *     1. 单页 timeout（默认 30s）—— 防 hang 拖死整个 build
 *     2. retry（默认 3 次，指数退避 200/400/800ms）—— 只重试可恢复错误
 *        （timeout / network / 5xx），4xx 不重试（重试也是错的 URL）
 *     3. 整体失败率 > failBuildThreshold（默认 5%）→ build 直接失败
 *        即使 continueOnError = true 也会在最后 throw，强制 fail-loud
 *
 * 与 ISR 的关系：
 *   SSG 在 build 时一次性产出纯静态 HTML，之后由 CDN / express.static 直接 serve
 *   —— 首次请求不经过 RSC handler，不触发 Flight 流渲染，也就不进 ISR 缓存（也不需要）
 *   对于"变更低频 + SEO 强依赖"的页面（About / 条款 / Landing），SSG 是首选
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@/logger/Logger';

const logger = Logger.getInstance();

/** fetch handler 约定（与 @vitejs/plugin-rsc src/entry.server.tsx 默认导出一致） */
export interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

export interface SpiderOptions {
  /** 爬取基础 URL（构造 Request 用，与实际 serve 域名无关） */
  baseUrl?: string;
  /** 并发度，默认 3 */
  concurrency?: number;
  /**
   * 是否允许单页错误时继续（默认 true）。false → 遇到第一个失败就抛错。
   *
   * 注意：true 也不等于"全程不抛"——见 `failBuildThreshold`。建议组合：
   *   continueOnError: true + failBuildThreshold: 0.05 = "允许零星 flake，但失败率超阈值整体失败"
   */
  continueOnError?: boolean;
  /**
   * 单页请求超时毫秒数，默认 30_000。超时记为可重试错误。
   * 设 0 关闭（不推荐——某个页面 hang 会拖死整个 build）。
   */
  requestTimeoutMs?: number;
  /**
   * 单页最大重试次数（不含首次），默认 3。
   * 只重试「可恢复错误」：timeout / 网络异常（fetch 抛 TypeError）/ 5xx 状态码。
   * 4xx 永远不重试——状态码语义上是请求本身错的，重试也没用。
   */
  maxRetries?: number;
  /**
   * 重试初始退避毫秒，默认 200。指数退避：第 N 次重试等待 base * 2^(N-1) ms。
   * 默认 3 次重试 = 200/400/800ms 间隔。
   */
  retryBaseDelayMs?: number;
  /**
   * 整体失败率阈值（0.0-1.0），默认 0.05（5%）。spider 跑完后，若
   * `failed/total > threshold` 则抛 `SsgBuildFailedError`，即使 continueOnError = true。
   * 设 1.0 → 永不因失败率 fail build（保留历史行为，不推荐）。
   * 设 0 → 任何失败都 fail build（等价于 continueOnError = false 的最终态）。
   */
  failBuildThreshold?: number;
}

export interface SpiderResult {
  successful: number;
  failed: number;
  total: number;
  /** 全程失败率（0-1）；调用方用于决策是否回滚部署 */
  failureRate: number;
  routes: Array<{
    route: string;
    outFile: string;
    bytes: number;
    status: number;
    ok: boolean;
    error?: string;
    /** 实际尝试次数（含首次），>1 表示用了 retry */
    attempts: number;
  }>;
}

/**
 * spider 跑完后整体失败率超过阈值时抛出。含全部 SpiderResult，便于上层
 * 决定回滚 / 告警 / 写入构建报告。
 */
export class SsgBuildFailedError extends Error {
  public readonly result: SpiderResult;
  public readonly threshold: number;
  constructor(result: SpiderResult, threshold: number) {
    super(
      `SSG build failed: ${result.failed}/${result.total} routes failed ` +
        `(${(result.failureRate * 100).toFixed(1)}% > ${(threshold * 100).toFixed(1)}% threshold)`
    );
    this.name = 'SsgBuildFailedError';
    this.result = result;
    this.threshold = threshold;
  }
}

/**
 * 将路由路径转换为磁盘写入路径
 */
export function routeToFilePath(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'index.html';
  return `${trimmed}/index.html`;
}

/** 网络/瞬时错误判定 —— 决定是否重试 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    // fetch 抛的 TypeError 通常是网络层（DNS / connection refused / abort）
    if (err.name === 'TypeError') return true;
    // AbortError = 我们自己的 timeout
    if (err.name === 'AbortError') return true;
    // 显式标记的 timeout
    if (err.message.includes('timed out')) return true;
  }
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * 单次 fetch + 超时包裹。超时抛 AbortError（被 isRetryableError 捕获走 retry）。
 */
async function fetchWithTimeout(
  handler: FetchHandler,
  url: string,
  timeoutMs: number
): Promise<Response> {
  if (timeoutMs <= 0) {
    return handler.fetch(new Request(url, { method: 'GET' }));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 注意：Request 的 signal 由调用方传入；plugin-rsc 的 default fetch handler
    // 接受 signal，会在 abort 时停止内部任务（v0.5+）。旧版本 handler 可能忽略，
    // 但仍然 race 我们自己的 timer，最终通过 reject 让 retry 接管。
    const response = await Promise.race<Response>([
      handler.fetch(new Request(url, { method: 'GET', signal: ctrl.signal })),
      new Promise<Response>((_, reject) => {
        ctrl.signal.addEventListener('abort', () =>
          reject(new Error(`SSG fetch timed out after ${timeoutMs}ms`))
        );
      }),
    ]);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 爬取一组 SSG 路由并写入静态 HTML
 */
export async function spiderSsgRoutes(params: {
  handler: FetchHandler;
  routes: readonly string[];
  outDir: string;
  options?: SpiderOptions;
}): Promise<SpiderResult> {
  const {
    handler,
    routes,
    outDir,
    options: {
      baseUrl = 'http://localhost',
      concurrency = 3,
      continueOnError = true,
      requestTimeoutMs = 30_000,
      maxRetries = 3,
      retryBaseDelayMs = 200,
      failBuildThreshold = 0.05,
    } = {},
  } = params;

  const results: SpiderResult['routes'] = [];
  let successful = 0;
  let failed = 0;

  const active = new Set<Promise<void>>();

  const run = async (route: string): Promise<void> => {
    const url = new URL(route, baseUrl).toString();
    const requestUrl = url.replace(/\?$/, '');
    let attempts = 0;
    // 跨迭代追踪：5xx 重试时记下最后一个 HTTP 状态，便于 catch 路径报告
    // （如 attempt 1 = 503，attempt 2 抛网络错误时 results 里 status 还能反映 503）
    let lastStatus = 0;

    while (attempts <= maxRetries) {
      attempts++;
      try {
        const response = await fetchWithTimeout(handler, requestUrl, requestTimeoutMs);
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();

        if (!response.ok) {
          lastStatus = response.status;
          // 4xx 不重试（请求本身就是错的，重试也是错的）
          if (!isRetryableStatus(response.status) || attempts > maxRetries) {
            results.push({
              route,
              outFile: '',
              bytes: text.length,
              status: response.status,
              ok: false,
              error: `HTTP ${response.status}`,
              attempts,
            });
            failed++;
            logger.warn(`[SSG] ✗ ${route} → HTTP ${response.status} (attempts=${attempts})`);
            if (!continueOnError) {
              throw new Error(`SSG 抓取失败: ${route} HTTP ${response.status}`);
            }
            return;
          }
          // 5xx + 还能重试 → 继续 while 循环
          await sleep(retryBaseDelayMs * Math.pow(2, attempts - 1));
          continue;
        }

        if (!contentType.includes('text/html')) {
          // content-type 不对通常是配置问题，不是瞬时错误，不重试
          results.push({
            route,
            outFile: '',
            bytes: text.length,
            status: response.status,
            ok: false,
            error: `unsupported content-type: ${contentType}`,
            attempts,
          });
          failed++;
          logger.warn(`[SSG] ✗ ${route} → 非 HTML 响应 (${contentType}, attempts=${attempts})`);
          if (!continueOnError) {
            throw new Error(`SSG 非 HTML 响应: ${route} ${contentType}`);
          }
          return;
        }

        // 成功路径
        const rel = routeToFilePath(route);
        const outFile = path.join(outDir, rel);
        await fs.mkdir(path.dirname(outFile), { recursive: true });
        await fs.writeFile(outFile, text, 'utf-8');

        results.push({
          route,
          outFile: path.relative(process.cwd(), outFile),
          bytes: text.length,
          status: response.status,
          ok: true,
          attempts,
        });
        successful++;
        const retrySuffix = attempts > 1 ? ` (after ${attempts - 1} retries)` : '';
        logger.info(
          `[SSG] ✓ ${route} → ${path.relative(process.cwd(), outFile)} (${text.length}B)${retrySuffix}`
        );
        return;
      } catch (err) {
        if (isRetryableError(err) && attempts <= maxRetries) {
          await sleep(retryBaseDelayMs * Math.pow(2, attempts - 1));
          continue;
        }
        // 非可重试 / 重试已耗尽
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          route,
          outFile: '',
          bytes: 0,
          status: lastStatus,
          ok: false,
          error: message,
          attempts,
        });
        failed++;
        logger.error(`[SSG] ✗ ${route} (attempts=${attempts})`, err);
        if (!continueOnError) {
          throw err;
        }
        return;
      }
    }
    // 不可达：while 体内每个分支都已 return 或 continue。
    // 5xx 重试耗尽时 `attempts > maxRetries` 检查会在 if(!response.ok) 路径里 fire 并 return。
    // 此处保留是为了让 TS 看到 `run` 一定 return（无显式 return 路径）。
  };

  for (const route of routes) {
    const task = run(route).finally(() => {
      active.delete(task);
    });
    active.add(task);
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);

  const total = routes.length;
  const failureRate = total > 0 ? failed / total : 0;
  const result: SpiderResult = {
    successful,
    failed,
    total,
    failureRate,
    routes: results,
  };

  // Fail-build threshold check —— 即使 continueOnError = true 也会触发
  if (total > 0 && failureRate > failBuildThreshold) {
    throw new SsgBuildFailedError(result, failBuildThreshold);
  }

  return result;
}

/**
 * SSG 路由来源形状（兼容同步 / 异步函数两种配置）
 */
export type SsgRoutesSource =
  | readonly string[]
  | (() => readonly string[] | string[] | Promise<readonly string[] | string[]>);

type RouteEntry = string | { mode: string; ttl?: number; staleWhileRevalidate?: number };

function entryMode(entry: RouteEntry): string {
  return typeof entry === 'string' ? entry : entry.mode;
}

/**
 * 从 ISRConfig 中提取 SSG 路由列表
 *   优先级：ssg.routes > routes/routeOverrides (mode=ssg)
 */
export async function extractSsgRoutes(config: {
  ssg?: { routes?: SsgRoutesSource };
  routes?: Record<string, RouteEntry>;
  routeOverrides?: Record<string, RouteEntry>;
}): Promise<string[]> {
  const ssgConf = config.ssg?.routes;
  if (ssgConf) {
    const value = typeof ssgConf === 'function' ? await ssgConf() : ssgConf;
    return Array.from(value);
  }

  const source = config.routeOverrides ?? config.routes ?? {};
  const ssgRoutes: string[] = [];
  for (const [pathValue, entry] of Object.entries(source)) {
    if (entryMode(entry) === 'ssg' && !pathValue.includes('*')) {
      ssgRoutes.push(pathValue);
    }
  }
  return ssgRoutes;
}
