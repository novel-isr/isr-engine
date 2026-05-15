/**
 * ISR cache inventory 端点 —— 暴露当前 L1 缓存条目元数据 + 最近 invalidate 时间。
 *
 * 用途：回答 “这一刻，哪些页面的缓存是 stale？某 path/tag 上次什么时候被 revalidate？”
 * 这类 *库存视角* 问题。流量视角（按路由 cache 状态分布）走 Prometheus
 * `isr_http_requests_total{cache="STALE",route=...}`；本端点是补充而非替代。
 *
 * 边界（明确写在这里防止滑坡）：
 *   ✅ 只读 L1（in-process LRU），永不 SCAN Redis（SCAN 阻塞，量大不该走 engine）
 *   ✅ 只返回元数据：key / 时间戳 / size / tags；body 一字节都不返回
 *   ✅ 只给 JSON，不给 HTML 浏览器（漂亮 UI 走业务自建或单独包）
 *   ✅ 鉴权复用 opsConfig.authToken，不引入 SSO/RBAC（那是业务网关的事）
 *   ✅ 端点路径 /__isr/cache/inventory 已在 isrCacheMiddleware.isBypassPath 列表，
 *      自身永远不会被 ISR 缓存
 *
 * 查询参数：
 *   ?status=fresh|stale|expired|all   过滤 L1 条目状态（默认 all）
 *   ?limit=N                          L1 条目数上限（默认 100，硬上限 1000）
 *   ?l2=true|false                    是否包含 L2（Redis）SCAN 视图（默认 true,
 *                                      hybrid 模式才有内容；memory 模式恒为 [] 不发请求）
 *   ?l2Limit=N                        L2 SCAN 条目数上限（默认 200，硬上限 500，防 SCAN 流量过大）
 *
 * 响应示例（hybrid 模式）：
 *   {
 *     "now": 1715760000000,
 *     "backend": "hybrid",
 *     "size": 234,             // L1 条目数
 *     "max": 1000,             // L1 容量
 *     "filtered": 12,          // L1 过滤后条目数
 *     "entries": [...],        // L1 条目（含 fresh/stale/expired 状态）
 *     "invalidations": [...],  // 最近 invalidate 时间
 *     "l2": {
 *       "scanned": 234,
 *       "items": [
 *         { "key": "GET:/books/1", "sizeBytes": 12450, "ttlSecondsRemaining": 1800, "onlyInL2": false },
 *         { "key": "GET:/cold-page", "sizeBytes": 800, "ttlSecondsRemaining": 7200, "onlyInL2": true }
 *       ]
 *     }
 *   }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';
import type { IsrCacheHandler, IsrCacheInspectionEntry } from './isrCacheMiddleware';
import type { ResolvedOpsConfig } from '../server/opsConfig';
import { createOpsAuthMiddleware } from '../server/opsConfig';

/** Inventory 端点路径常量 —— 与 isrCacheMiddleware.isBypassPath 中的 /__isr 前缀对齐 */
export const CACHE_INVENTORY_PATH = '/__isr/cache/inventory';

/** L1 单次响应最多条目数（硬上限），避免极端情况返回 5MB+ JSON */
const HARD_LIMIT = 1000;
/** L1 默认 limit */
const DEFAULT_LIMIT = 100;
/** L2 SCAN 单次返回硬上限 —— 比 L1 更严，因为每个 entry 一次 STRLEN+TTL 是 2 个 Redis 命令 */
const L2_HARD_LIMIT = 500;
/** L2 默认 limit */
const L2_DEFAULT_LIMIT = 200;

type StatusFilter = 'fresh' | 'stale' | 'expired' | 'all';

function parseStatusFilter(raw: string | null): StatusFilter {
  if (raw === 'fresh' || raw === 'stale' || raw === 'expired' || raw === 'all') return raw;
  return 'all';
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, HARD_LIMIT);
}

function parseL2Limit(raw: string | null): number {
  if (!raw) return L2_DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return L2_DEFAULT_LIMIT;
  return Math.min(n, L2_HARD_LIMIT);
}

function parseBoolFlag(raw: string | null, defaultValue: boolean): boolean {
  if (raw === null) return defaultValue;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defaultValue;
}

/**
 * 创建 inventory 中间件。
 *
 * 必须在 ISR cache middleware 之前挂（路径已在 isBypassPath 但提前挂可以避开
 * cache handler 内部 metric 记录这次 admin 请求）。
 *
 * @param handler ISR cache handler，必须支持 getCacheInspection()
 * @param opsConfig resolveOpsConfig 的输出 —— inventory.enabled 控制端点是否生效
 */
export function createCacheInspectorMiddleware(
  handler: IsrCacheHandler,
  opsConfig: ResolvedOpsConfig
): Connect.NextHandleFunction {
  // disabled 时直接返回 no-op，运行期不引入任何分支开销
  if (!opsConfig.inventory.enabled) {
    return (_req, _res, next) => next();
  }

  const auth = createOpsAuthMiddleware('inventory', opsConfig);

  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    // 用 URL 解析路径（剥 query string）。req.url 一定有，但形态可能含 query。
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    if (pathOnly !== CACHE_INVENTORY_PATH) {
      next();
      return;
    }

    // 鉴权 —— public=true 时 createOpsAuthMiddleware 返回 noop next()
    auth(req as never, res as never, () => {
      void respond(req, res, handler);
    });
  };

  async function respond(
    req: IncomingMessage,
    res: ServerResponse,
    h: IsrCacheHandler
  ): Promise<void> {
    try {
      const snapshot = h.getCacheInspection();
      const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const statusFilter = parseStatusFilter(params.get('status'));
      const limit = parseLimit(params.get('limit'));
      const includeL2 = parseBoolFlag(params.get('l2'), true);
      const l2Limit = parseL2Limit(params.get('l2Limit'));

      const filtered: IsrCacheInspectionEntry[] =
        statusFilter === 'all'
          ? snapshot.entries
          : snapshot.entries.filter(e => e.status === statusFilter);

      // 排序：fresh 先返回最新入缓存的；stale/expired 先返回最旧的（最该被关注）。
      // 对于 all：按 ageSeconds 降序（旧的优先），方便排错时一眼看到长期未刷新的条目。
      const sorted = [...filtered].sort((a, b) => b.ageSeconds - a.ageSeconds);
      const limited = sorted.slice(0, limit);

      const sortedInvalidations = [...snapshot.invalidations].sort(
        (a, b) => b.lastInvalidatedMs - a.lastInvalidatedMs
      );

      // L2 视图（仅 hybrid 模式有内容）—— 异步 SCAN 拉取
      const l2Items =
        includeL2 && snapshot.backend === 'hybrid' ? await h.getL2Inspection(l2Limit) : [];

      const body = JSON.stringify(
        {
          now: snapshot.now,
          backend: snapshot.backend,
          size: snapshot.size,
          max: snapshot.max,
          filter: { status: statusFilter, limit, l2: includeL2, l2Limit },
          filtered: filtered.length,
          entries: limited,
          invalidations: sortedInvalidations,
          l2: { scanned: l2Items.length, items: l2Items },
        },
        null,
        2
      );

      if (res.headersSent) return;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    } catch (err) {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }
}
