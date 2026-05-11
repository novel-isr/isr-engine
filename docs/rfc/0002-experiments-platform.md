# RFC 0002 — Experiments Platform（曝光上报 + Manifest 拉取 + 灰度运营）

| 字段 | 值 |
|---|---|
| Status | **Draft** |
| Author | engine 维护组 |
| Created | 2026-05-12 |
| Depends on | RFC 0001 |

## TL;DR

RFC 0001 把 A/B 的 **机制层** 跑通（anonId + 确定性 hash + ISR cache 兼容）。本 RFC 在 engine 侧补齐让真实业务能跑实验闭环的三块能力：

1. **Server-side 曝光上报** —— engine 在每次 SSR 时把 (anonId, expKey, variant, path, requestId) 异步打到业务侧 endpoint，不阻塞渲染
2. **Manifest 拉取** —— engine 周期从 admin-server 拉实验定义；运营改 weights / status 秒级生效，不重启 server
3. **灰度发布原语** —— `status: 'running' | 'paused' | 'killed'` + kill switch 接口；engine 收到 killed 信号立刻所有流量回 control

业务侧（admin-server PG schema、admin-platform 运营 UI、统计层 z-test）不在本 RFC，**只描述 engine 必须暴露的接口契约**。

## 1. 配置 Surface（`ssr.config.ts`）

### 1.1 三个新字段（向后兼容 / opt-in）

```ts
runtime: {
  // 既有：实验定义（静态配置 fallback）
  experiments: {
    'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
    // ...
  },

  // 新增：实验定义动态拉取
  experimentManifest: {
    /** admin-server endpoint。不配 → engine 只读 experiments 静态配置，不联网 */
    endpoint?: string;
    /** 拉取间隔，默认 60_000ms */
    refreshIntervalMs?: number;
    /** 拉取失败时的回退策略 */
    fallbackOnError?: 'cache' | 'static' | 'empty';
    /** 鉴权头（如 Bearer token） */
    authHeader?: { name: string; value: string };
  };

  // 新增：曝光上报
  experimentTracking: {
    /**
     * admin-server endpoint。
     * - 相对路径（/api/...）→ 拼到 services.telemetry 前面
     * - 绝对路径（http(s)://）→ 直接用
     * 不配 → engine 不上报，A/B 只在内存里跑，回到 RFC 0001 状态
     */
    endpoint?: string;
    /** 批量大小，默认 100 */
    batchSize?: number;
    /** 批量 flush 间隔，默认 1000ms */
    flushIntervalMs?: number;
    /** 采样率 [0, 1]，默认 1.0；高 QPS 时降到 0.1 */
    sampleRate?: number;
    /** 一键关闭（调试用） */
    enabled?: boolean;
  };
},
```

### 1.2 优先级解析

实验定义按顺序合并（高优先级覆盖低优先级）：

```
manifest 拉取结果 > experiments 静态配置（fallback）
```

manifest 拉取失败时：
- `fallbackOnError: 'cache'` → 用上一次拉成功的缓存（默认；推荐）
- `fallbackOnError: 'static'` → 用 `experiments` 字段
- `fallbackOnError: 'empty'` → 关闭所有实验，回 control

## 2. Manifest 拉取协议

### 2.1 Engine → admin-server

```http
GET /api/experiments/manifest
If-None-Match: "v123"
Authorization: Bearer <token>  ← 仅当 authHeader 配置
```

### 2.2 admin-server 响应

`304 Not Modified`（命中 ETag）或：

```http
200 OK
ETag: "v124"
Cache-Control: public, max-age=60
Content-Type: application/json

{
  "version": "v124",
  "updatedAt": "2026-05-12T10:00:00Z",
  "experiments": {
    "hero-style": {
      "variants": ["classic", "bold"],
      "weights": [50, 50],
      "status": "running",
      "targeting": {
        "locales": ["zh-CN", "en"],
        "paths": ["/", "/books/*"]
      }
    },
    "new-checkout": {
      "variants": ["legacy", "v2"],
      "weights": [99, 1],
      "status": "running"
    },
    "deprecated-feature": {
      "variants": ["off", "on"],
      "weights": [100, 0],
      "status": "killed"
    }
  }
}
```

### 2.3 engine 解析规则

| `status` | engine 行为 |
|---|---|
| `running` | 正常按 weights 分桶 |
| `paused` | 不分桶，所有流量回第一个 variant（control） |
| `killed` | 同 paused，但 admin-platform 应高亮提醒 |
| 字段缺失 | 视作 `running`（向后兼容） |

`targeting` 字段（可选）—— RFC 范围内只声明 schema，engine 实现可分阶段：

```ts
targeting?: {
  /** locale 白名单；不在列表内的请求跳过此实验 */
  locales?: string[];
  /** path glob 白名单；不匹配的请求跳过此实验 */
  paths?: string[];
  /** 用户角色（仅登录态生效） */
  userRoles?: string[];
};
```

## 3. 曝光上报协议

### 3.1 触发点

`ABVariantMiddleware` 算完 `ctx.experiments` 之后，**fire-and-forget** 入队：

```ts
// engine 伪代码
const assignments = computeAssignments(ctx.anonId, experiments);
ctx.experiments = assignments;

if (Object.keys(assignments).length > 0 && trackingEnabled) {
  exposureQueue.push({
    anonId: ctx.anonId,
    userId: ctx.userId ?? null,
    requestId: ctx.requestId,
    experiments: assignments,
    path: stripQuery(req.url),
    ts: Date.now(),
  });
}

next();
```

### 3.2 批量 flush

```
exposureQueue: 内存数组，最多 batchSize * 2 兜底防爆
flush 触发：
  - 队列达到 batchSize → 立即 flush
  - 距上次 flush 超过 flushIntervalMs → 定时器 flush
  - 进程退出（SIGTERM）→ 同步 flush 最后一批
```

### 3.3 Engine → admin-server

```http
POST /api/observability/experiments
Content-Type: application/json

{
  "events": [
    {
      "anonId": "...",
      "userId": "...",
      "requestId": "...",
      "experiments": { "hero-style": "bold" },
      "path": "/zh-CN",
      "ts": 1715508000000
    },
    // ...
  ]
}
```

### 3.4 失败处理

| 场景 | 行为 |
|---|---|
| HTTP 5xx | 退避 1 次（500ms）后再 retry；仍失败丢弃 + warn log |
| HTTP 4xx | 不 retry，丢弃 + error log（配置错误，要修） |
| 网络不通 | 同 5xx |
| admin-server 全宕 | 队列累积到 batchSize×2 时丢最早的（FIFO）+ 一次 critical log |
| 进程崩溃 | 接受丢失（曝光数据非交易，最多差一批） |

**绝对不让上报失败影响业务渲染。** 业务侧渲染路径与 exposure 路径完全异步。

### 3.5 去重哲学

engine 不做去重 —— **写入全量，查询期 `COUNT(DISTINCT anon_id)`**：

```sql
SELECT variant_id, COUNT(DISTINCT anon_id) AS users
FROM experiment_exposures
WHERE experiment_key = 'hero-style' AND ts > NOW() - INTERVAL '7d'
GROUP BY variant_id;
```

业界共识（GrowthBook / Statsig / LinkedIn LiX 同款）：写入去重需要事务 + UNIQUE 索引代价高；analytics 查询天然支持 DISTINCT，不如分析期做。

## 4. 灰度发布原语

### 4.1 流量调权

`weights` 字段可在 manifest 任意改：

```
weights: [99, 1] → [95, 5] → [75, 25] → [50, 50] → [0, 100]
```

engine 每 60s 拉一次 manifest，运营在 admin-platform 改完后最多 60s 全 fleet 生效。

**关键**：分桶函数是 `fnv1a32(anonId + ':' + expKey)`，跟 weights 无关。weights 变化时，bucket 边界位移：

- weights 50/50 → bucket [0, 5000) classic, [5000, 10000) bold
- weights 70/30 → bucket [0, 7000) classic, [7000, 10000) bold

某个 anonId 的 bucket 是稳定的（hash 输出固定），所以边界变化时**部分用户会改变看到的变体**。

> ⚠️ **这是灰度的预期行为**：从 1% 升到 5% 时，原本被分到 5% 桶（hash 落在 [9500, 10000)）的用户保持在 bold，新增 4% 流量（hash 落在 [9100, 9500)）改看 bold。原 classic 用户保持 classic。
>
> 但反向操作（从 100% 降到 50%）会让一半的 bold 用户回滚到 classic，**视觉上不稳定**。**生产实践**：灰度只升不降；想下线某变体走 `status: 'killed'` 而不是降权重。

### 4.2 Kill Switch

manifest 改 `status: 'killed'` → 下次拉取（最多 60s）engine 全 fleet 立刻全流量回 control。

**热停**（不等 60s）：admin-server 通过 Redis pub/sub 推 invalidation（engine 已有 `RedisInvalidationBus`），发 `experiments:invalidate` 通道消息，engine 立刻重拉 manifest。

```ts
runtime.redis.invalidationChannel: 'novel-rating:isr:invalidate'  // 既有
// 新增频道 'novel-rating:experiments:invalidate' 走同一 bus
```

### 4.3 Per-variant 错误率监控

engine 已有 prometheus metrics（`PromMetrics.ts`）。新增 label：

```
http_requests_total{status_class, experiment_key, variant_id}
http_request_duration_seconds{experiment_key, variant_id}
```

每个请求渲染期 `ctx.experiments` 解析后，把 experiment_key + variant_id 作为 label 喂给已有 metrics。

admin-server 起一个 worker 周期查 prometheus，发现某 variant 错误率超阈值 → 自动改 manifest `status: 'killed'` → engine 自动 rollback。

阈值规则示例：

```ts
// admin-server 侧的规则（不在 engine 范围，仅声明配置形态）
{
  experimentKey: 'new-checkout',
  rollbackOn: {
    errorRatePct: 5,         // 错误率 > 5% 触发
    minRequests: 1000,       // 至少 1000 请求才生效（小样本不算）
    p99LatencyMs: 5000,      // p99 延迟 > 5s 触发
    durationSec: 60,         // 持续超阈值 60s 才触发
  }
}
```

## 5. 实施分期

| 阶段 | 范围 | 工程量 | 验收 |
|---|---|---|---|
| **P1** | server-side exposure（§3）+ batch / retry | 1.5 天 | 业务配 `experimentTracking.endpoint`，admin-server 收到批量曝光事件 |
| **P2** | manifest 拉取（§2）+ 60s 轮询 + ETag | 1 天 | 改 admin-server 的实验定义，engine 60s 内生效 |
| **P3** | status 字段（§4.2 kill switch） | 0.5 天 | `status: 'killed'` 触发 60s 内回 control |
| **P4** | Redis pub/sub 热停（§4.2 热停） | 0.5 天 | admin-server 推消息后 engine < 1s 重拉 manifest |
| **P5** | per-variant prometheus metrics（§4.3） | 0.5 天 | grafana 能按 variant 切错误率图 |
| **P6** | targeting（§2.3）的 locales / paths 维度 | 1 天 | 实验只对配置的 locale / path 生效 |

P1 + P2 + P3 = 闭环最小集（3 天）。P4 ~ P6 是 production-grade 增强。

## 6. API 兼容性

| 现有 API | 升级后行为 |
|---|---|
| `runtime.experiments` 静态配置 | 保留为 fallback；manifest 拉取成功时被覆盖 |
| `getVariant(name)` | 完全不变 |
| `getExperiments()` | 完全不变 |
| `ctx.experiments` shape | 完全不变 |
| `createABVariantMiddleware({ experiments })` | 接收的 experiments 改读「effective experiments」（manifest 优先），运行时动态可变 |

**零破坏性升级**。业务侧不配新字段 → engine 行为跟当前完全一致。

## 7. 不在本 RFC 范围

| 主题 | 落点 |
|---|---|
| admin-server PG schema / endpoints 实现 | 业务侧文档 `design-experiments.md` §2-3 |
| admin-platform 运营 UI | 业务侧文档 §4 |
| 统计层（z-test / Bayesian）| 业务侧文档 §6 |
| 客户端 conversion 上报 SDK | 业务侧文档 §3 / novel-isr-analytics |
| GDPR consent 集成 | 单独 RFC（涉及 cookie 写入策略整体调整） |
| Edge-level anonId 分配（Cloudflare Worker / Lambda@Edge） | 单独 RFC，作为 CDN 缓存命中率优化的备选 |
| Mutual exclusion groups（互斥实验层）| 实验数量 > 10 个并发时再做 |

## 8. 风险

| 风险 | 缓解 |
|---|---|
| manifest 拉取放大对 admin-server 的 QPS | engine 60s 间隔 + ETag 304 节流；单实例每分钟 1 个请求 |
| exposure 队列内存膨胀（极端流量 / admin-server 长宕）| 队列上限 `batchSize × 2`，FIFO 丢最早；critical log 告警 |
| weights 频繁调整导致用户体验跳变 | 文档明确「只升不降」+ kill 走 status，admin-platform UI 加交互拦截 |
| anonId 落 cookie 触发 GDPR 合规风险 | 暴露 `cookieConsent: 'always' \| 'opt-in'` 配置，opt-in 模式下首屏 SSR 用 IP hash 替代（单独 RFC） |
| 多 pod 部署时 manifest 不同步（一个拉到新版本另一个还在旧）| 不修。允许 60s 内不同 pod 看到不同 manifest；business impact 极小（仅 weights 微差） |

## 9. 相关代码（实施时新增 / 修改）

预计新增：
- `src/experiments/ManifestLoader.ts` — 60s 拉取 + ETag + fallback
- `src/experiments/ExposureQueue.ts` — 批量 + retry + flush
- `src/experiments/ExperimentTargeting.ts` — locale / path 过滤
- `src/types/ExperimentsConfig.ts` — `experimentManifest` / `experimentTracking` shape

预计修改：
- `src/middlewares/ABVariantMiddleware.ts` — 接 ExposureQueue
- `src/cache/RedisInvalidationBus.ts` — 多频道支持（experiments invalidate）
- `src/metrics/PromMetrics.ts` — 加 experiment_key / variant_id label
- `src/types/ISRConfig.ts` — 加新字段
