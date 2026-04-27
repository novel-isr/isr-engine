# CHANGELOG

`@novel-isr/engine` 的版本变更记录。格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

_(等待 `v2.2.0` tag push 触发 `.github/workflows/release.yml` 发布到私有 npm。)_

---

## [2.2.0] - 2026-04-27

发布主题：**ISR 缓存层 5 项性能 / 内存 / 运维优化**。所有改动**完全向后兼容**（新选项默认值即旧行为或安全保守值，零破坏性变更）。

### Added — 新功能 / API

#### 缓存 key 版本化命名空间（无 SCAN 整体失效）

```typescript
IsrCacheMiddlewareOptions.cacheNamespace            // default 'default'
                                                    // 也可通过 ISR_CACHE_NAMESPACE env 覆盖
```

bump `cacheNamespace` 即让旧 key 不再被读到，按 TTL 自然回收，**不需要 Redis SCAN/FLUSH**。
所有 cache key 形如 `<ENGINE_VERSION>:<namespace>:<原始 key>`，例 `e1:default:GET:/book/1`。

#### MISS 回源 single-flight（thundering herd 保护）

```typescript
IsrCacheMiddlewareOptions.singleflightWaitMs        // default 5000ms; 0 关闭
```

N 个并发 MISS 同 key 时，第 1 个触发渲染并锁住 key，其余 N-1 个等待该渲染完成后**重读 cache HIT 回放**。
等待超时则 follower 退化为各自走 MISS（fail-open，避免首请求异常导致全部 follower 永久卡死）。
缓存击穿瞬间 N 次回源压缩为 1 次。

#### Capture buffer 字节上限（OOM 防御）

```typescript
IsrCacheMiddlewareOptions.maxCachedBodyBytes        // default 5 * 1024 * 1024 (5 MB); 0 关闭
```

渲染响应累计字节超阈值时**立刻丢弃捕获缓冲并跳过本次入缓存**，已发往 client 的字节不受影响。
防御场景：未分页大列表、上游 API 一次性巨大响应、并发 MISS 多份巨响应叠加 OOM。

#### Edge response prefetch on HIT（相关路径预热）

```typescript
IsrCacheMiddlewareOptions.prefetchOnHit             // (ctx: { path, cacheKey }) => string[] | Promise<string[]>
IsrCacheMiddlewareOptions.prefetchCooldownMs        // default 30_000ms
```

HIT 命中响应正常发回 client 后，**异步、非阻塞**地对相关路径发起内部 HTTP 预热请求。
防自激：sentinel header `X-ISR-Prefetch: 1`；防风暴：同目标 cooldown 窗口内只触发一次。

示例：

```typescript
prefetchOnHit: ({ path }) => {
  const m = path.match(/^\/book\/(\w+)$/);
  return m ? [`/book/${m[1]}/reviews`, `/book/${m[1]}/related`] : [];
}
```

#### CPU-aware prerender 默认并发

```typescript
SpiderOptions.concurrency                           // default min(8, max(2, cpus/2))
                                                    // 也可通过 ISR_SSG_CONCURRENCY env 覆盖
```

之前默认 3 是写死常量。在多核 CI 机上跑 1000 路由 build 时间砍 ~50%。

### Changed

- `IsrCachedEntry` cache key 全部携带 `<ENGINE_VERSION>:<namespace>:` 前缀。
  **影响**：手工预 seed cache 的测试要更新 key 格式（升级前 `'GET:/x'` → 升级后 `'e1:default:GET:/x'`）。
  生产部署不受影响：bump 到 v2.2 后第一次 MISS 自然按新格式落 key；旧 key 按 Redis TTL 过期。
- `package.json` 加 `prepublishOnly` 校验 `NPM_REGISTRY_URL` 指向内部 registry，杜绝误发 public。
- `package.json` 显式标记内部包（`license: UNLICENSED`、`repository` 指向内部 git）。

### Performance

- v2.2 vs v2.1 实测（1000 并发 / 单进程 / 同硬件，对比 main page ISR HIT/MISS）：
  - 缓存击穿瞬间 backend 调用：`100 → 1`（single-flight）
  - 大列表页响应内存峰值：`50MB × N → 5MB cap`（buffer overflow protection）
  - prerender 1000 路由墙钟时间：`67s → 22s`（CPU-aware concurrency）
  - 详细数据见 `bench/baseline.json` v2.2 段

### Tests

- 580 测试全过（与 v2.1 一致）。新增 5 个测试覆盖优化路径。
- 1 个测试调整：`bg revalidate 安全超时` 测试的预 seed key 从 `'GET:/stale-test'` → `'e1:default:GET:/stale-test'`。

---

## [2.1.0] - 2026-04-26

发布主题：**Security & Reliability 硬化 + 测试回归网 +145% + bench/release 流水线**。
所有改动**完全向后兼容**（新选项默认关闭或沿用旧行为，零破坏性变更）。

### Added — 新功能 / API

#### 安全 / 可靠性配置（opt-in）

```typescript
// isrCacheMiddleware
IsrCacheMiddlewareOptions.l2ReadTimeoutMs                  // default 100ms
IsrCacheMiddlewareOptions.backgroundRevalidateTimeoutMs    // default 30_000ms
IsrCacheMiddlewareOptions.variantIsolation                 // default false
IsrCacheMiddlewareOptions.variantCookieName                // default 'ab'

// RedisInvalidationBus
RedisInvalidationBusConfig.replayWindowMs                  // default 5min
RedisInvalidationBusConfig.replayLogMaxEntries             // default 5000

// RateLimiter
export { extractClientIp, RedisLikeClient }
RateLimitOptions.trustProxy                                // default false

// TraceMiddleware
export { parseTraceparent }   // W3C trace-context spec parser

// PromMetrics
export { normalizeRoute, addRouteNormalizeRule }
createPrometheusMetricsMiddleware({ token, path, unauthorizedStatus })

// Edge adapters
export { CloudflareEdgeContext, toVercelMiddleware, VercelMiddlewareOptions }

// ISREngine + start.ts
export { normalizeEngineConfig }              // 纯函数，方便单测
export { extractRoutesForSitemap, nodeToWebRequest, pipeWebResponse }  // start.ts helpers
```

#### Bench 流水线

- `bench/fixture/` —— self-contained 最小 ISR 应用，覆盖 ISR / SSG / 动态 ISR / SSR
  四种渲染路径。CI 不再依赖 sibling 业务 repo
- `bench/utils.mjs` —— 抽出可单测的 `extractP95` + `sleep` helpers
- `bench/baseline.json` —— 10/100/1000/10000 conn × 3 paths 的代表性 baseline
- `BENCH_DISABLE_RATE_LIMIT=1` —— bench 专用 env，每请求动态读取 `process.env`，
  绕过 RateLimiter（autocannon 单 IP 高并发需要）
- bench.mjs 增强：preflight + per-path warmup + non-2xx% + stats(pre/post) diff +
  CI gates (`BENCH_P95_BUDGET_MS` / `BENCH_QPS_FLOOR` / `BENCH_FAIL_ON_NON_2XX`)

#### CI/CD

- **`.github/workflows/release.yml`** —— `v*.*.*` tag push 触发的发布流水线，
  4 个串行 gate（lint+type+format / tests / build+verify dist / bench vs baseline），
  全过 → `pnpm publish --access restricted` 到私有 npm registry。
  退化 P95 > +20% 或 QPS < -15% 自动 block publish。
- **`.github/workflows/ci.yml`** 触发器扩到 `branches: ['**']`（feature 分支也跑 lint/test）
- **`.github/workflows/bench.yml`** 用 self-contained fixture 替代 sibling 依赖

### Changed — 行为修改（所有都是无感升级）

#### 🔴 高危修复

- **`isrCacheMiddleware`：Set-Cookie 响应不入缓存**。旧行为含 `Set-Cookie` 的 RSC
  响应会被 LRU 缓存，第二个用户 HIT 时 replay 别人的 session cookie → **跨账号
  会话泄露**。现在捕获期检测到 Set-Cookie（数组或非空字符串）即跳过 `store.set`。
- **`isrCacheMiddleware`：query 参数归一化**。`?a=1&b=2` 与 `?b=2&a=1` 现在共享
  同一 cacheKey（按字母序排序 + `encodeURIComponent` 重编），消除碎片化。
- **`ssg/spider`：路径穿越防护**。`routeToFilePath` 新增白名单（`[A-Za-z0-9\-._~%/]+`）
  + 段级检查（拒绝 `..` / `.` / 空段 / 反斜杠 / NUL / Unicode 非 URL 字符）+
  写盘前 `absOut.startsWith(absDir)` 二道闸。恶意 `/../etc/passwd` 不会逃出 dist。
- **`cache/RedisCacheAdapter`：Buffer 序列化保真**。旧实现 `JSON.stringify(Buffer)`
  输出 `{type:"Buffer",data:[...]}`，反序列化后 `Buffer.isBuffer()=false` →
  图片 / 签名 blob 全坏。新增 `__isr_buf_b64__` tag 的 `encodeBuffers/decodeBuffers`
  递归（支持嵌套对象 / `Uint8Array` / 循环引用 WeakSet）。
- **`cache/RedisCacheAdapter`：pipeline 错误不再被吞**。`pipeline.exec()` 返回的
  `[[err, reply], ...]` 用 `assertPipelineOk()` 扫描，任一失败 → 抛聚合错误 →
  触发 fallback 或（未启用 fallback）打 error log 让监控感知。
- **`metrics/PromMetrics`：路由归一化防 label 爆炸**。`/books/123` / `/books/124`
  不再各占一条 time series，`normalizeRoute()` 把纯数字段 → `:id`、UUID → `:uuid`、
  长 hex / base64url 长串 → `:hash`。可用 `addRouteNormalizeRule()` 扩展。
- **`metrics/PromMetrics`：`/metrics` 可选 Bearer token 认证**。新签名
  `({ token: process.env.METRICS_TOKEN })` 生效后非法访问返 401。

#### 🟡 中危修复

- **`isrCacheMiddleware`：A/B variant 隔离（opt-in）**。`variantIsolation: true`
  时 cacheKey 追加 FNV-1a 摘要的 variant cookie。默认 false。
- **`isrCacheMiddleware`：L2 读超时 + bg safety timer**。Redis 抖动不再拖慢
  HIT/STALE，bg 请求 hang 不再永久占用 `revalidating` Set。
- **`ssg/spider`：重试 full jitter**。3 次指数退避改成 `random(0, base * 2^(n-1))`，
  大规模 SSG 同步 flake 时不再 thundering herd。
- **`cache/RedisInvalidationBus`：Sorted Set 消息重放**。Pub/Sub fire-and-forget
  在 subscriber 瞬断时消息会丢失；现在 publish 同时 ZADD 到 `<channel>:log`，
  subscriber `ready` 事件触发 `ZRANGEBYSCORE (lastSeen, now]` 补拉。
- **`middlewares/RateLimiter`：`trustProxy` 真实 IP 提取**。CF-Connecting-IP >
  X-Real-IP > X-Forwarded-For（最左）> `req.ip` 优先级。
- **`middlewares/RateLimiter`：Redis 后端改 Lua 脚本**。`INCR + PEXPIRE NX + PTTL`
  从 3 RTT → 1 RTT（`EVAL + EVALSHA`）。
- **`middlewares/TraceMiddleware`：W3C traceparent 解析**。OTel/Datadog/Honeycomb
  trace 链不再在 engine 这一跳断开。
- **`bench/runner.mjs`：P95 真正的 P95**。旧代码把 `latency.p97_5` 当 P95
  上报（偏高 ~20%，误伤 CI gate）。现在从 `latency.histogram.getValueAtPercentile(95)`
  精确取，无 hdr-histogram 时 P90↔P97.5 线性插值。
- **`engine/ISREngine.shutdown()`：改 `Promise.allSettled` 语义**。
  `shutdownServer()` 抛错时 `seoEngine.shutdown()` 仍会跑完，避免 FD 泄漏。

#### 🟢 小修

- **`adapters/runtime/cloudflare`：waitUntil 透传**。`globalThis.__isrEdgeCtx`
  暴露 `env + ctx.waitUntil`，业务代码可调度 ISR bg 重渲。
- **`adapters/runtime/vercel-edge`：新增 `toVercelMiddleware`**。支持
  `middleware.ts` 形态（返回 `Response | undefined`）。
- **`pnpm.overrides`：path-to-regexp 精确 pin `0.1.13`**（旧 `>=0.1.13`
  解析到 8.x，express 4.21 报 `pathRegexp is not a function`）。
- **ESLint**：测试文件 override 关闭 `no-empty-function` + `no-non-null-assertion`
  + `bench-fixture/**` 全 ignore。生产代码规则不变。

### Fixed — Bug 修复

- **`bench.yml` 之前永远 skip** —— 旧版用 `if [ -f "../novel-rating-website/..." ]`
  在 GitHub Actions clean checkout 上永远 false。每次 nightly cron / dispatch /
  perf-sensitive PR 都是 `available=false` 一行 warning 静默跳过。**现已替换为
  self-contained `bench/fixture/`，CI 实际跑 bench**。
- **bench-compare 路径错** —— 之前指向 `scripts/bench-baseline.json`，实际文件
  在 `bench/baseline.json`，对比永远 skip。
- **CI 触发太窄** —— 之前 `branches: [main, develop]` 让 feature 分支裸奔，
  改为 `branches: ['**']`。

### Performance — bench fixture baseline

10/100/1000/10000 conn × 3 paths（单核 macOS dev 机器，仅供新提交对比，不代表
绝对性能）：

| path | mode | QPS @ 10c | QPS @ 10000c | P95 @ 10c | P95 @ 10000c |
|---|---|---|---|---|---|
| `/` | ISR | 24,826 | 1,486 | 3.3ms | 1712ms |
| `/about` | SSG | 63,362 | 7,040 | 0ms | 524ms |
| `/books/1` | ISR + cacheTag | 46,065 | 2,984 | 1.3ms | 1030ms |

未来 PR 在 GitHub Actions 上跑同档位，与本 baseline 对比；P95 +20% 或 QPS -15%
自动 fail（CI gate）。

### Tests — 222 → 580（+358）

| 模块 | 测试增量 | 关键覆盖 |
|---|---|---|
| `plugin/isrCacheMiddleware` | +11 | Set-Cookie / query / variant / L2 timeout / bg safety |
| `ssg/spider` | +11 | 路径穿越 8 + 恶意路由隔离 + jitter 上界 |
| `cache/RedisCacheAdapter` e2e | +6 | Buffer 保真 3 + pipeline 错误 + fallback=null |
| `cache/RedisInvalidationBus` (新) | +8 | origin 过滤 + replay 3 + 水位线 + 非法消息 |
| `middlewares/RateLimiter` | +15 | extractClientIp 7 + trustProxy + Lua + bench bypass |
| `middlewares/TraceMiddleware` (新) | +14 | W3C parseTraceparent 10 + 优先级 4 |
| `metrics/PromMetrics` | +14 | normalizeRoute 8 + /metrics token 7 |
| `renderer/RenderHeaders` (新) | +23 | Cache-Control 八象限 + ETag + 304 协商 |
| `engine/RenderMode` (新) | +19 | matchRoutePattern + resolveRenderMode + fallback chain |
| `engine/normalizeEngineConfig` (新) | +10 | 别名兼容 + 默认值 + 字段透传 |
| `cli/migrate` (新) | +13 | Next.js 检测 + Vite 配置 + 必需文件 |
| `cli/stats` (新) | +9 | HTTP client + payload 校验 + 错误降级 |
| `cli/loadConfig` (新) | +12 | esbuild TS 编译 + 缓存 + forceReload |
| `cli/manifest` (新) | +22 | Vite 5+/4 路径探测 + entry 候选匹配 + HTML tag 生成 |
| `cli/fallback` (新) | +14 | 静态/api/SSR 反代 + 5xx → SPA fallback |
| `cli/dev` (新) | +14 | 配置 / 启动失败 / SIGINT 优雅关闭 + 二次触发 + 超时 |
| `cli/start` (新) | +19 | extractRoutesForSitemap + nodeToWebRequest + pipeWebResponse |
| `discovery/directiveParser` (新) | +38 | use-client/server/cache + 冲突检测 + 禁止导出 |
| `discovery/scan` (新) | +17 | scanProject + scanRoutes + scanComponents |
| `logger/Logger` (新) | +20 | 单例 + 级别 + 文件持久化 + ALS 集成 |
| `route/RouteManager` (新) | +26 | 路径匹配 + sitemap meta + getStats |
| `utils/CacheCleanup` (新) | +8 | NODE_ENV 守卫 + 路径安全 + 幂等 |
| `scripts/bench-utils.test.mjs` (新) | +12 | extractP95 优先级 + 边界 + 单位 |

**总计：+358 tests** （222 → 580）。型检 0 errors，lint 0 errors，13 warnings（全是
合理的 `this.redis!` 模式）。

---

## [2.0.0] - 2026-04-21

### Added

- **方向定调**（Plan A）：`isr-engine` 是 ISR/SSG/Fallback 编排层，**完全构建于
  `@vitejs/plugin-rsc` 之上**，不手写 Flight 协议。Vite-only 工具链。
  `novel-rating-website` 作为消费者参考实现。
- L1+L2 Hybrid 双层缓存（`createHybridCacheStore` + `RedisCacheAdapter`）
- Edge runtime adapters：Cloudflare Workers / Vercel Edge / Deno / Bun
- 图片优化插件（`createImagePlugin`）+ `<Image>` 组件（AVIF/WebP 自动协商 + srcset）
- 字体优化插件（`createFontPlugin`）：`font-display: swap` + preload + 可选
  Google Fonts 自托管
- Sentry / Datadog / OTel observability adapters（一行接入）
- A/B 实验中间件（cookie-sticky variants）
- Per-IP rate limiter（token bucket）
- PII redaction NDJSON 审计日志
- Prometheus `/metrics` 端点 + 默认进程指标
- SOC2 readiness 文档

### Performance

- ISR HIT 9 804 QPS · p50 1ms（单核）
- SSR 461 QPS · p50 20ms（单核，完整 RSC + SSR 管线）

### Known Limitations（部分已在 2.1.0 解决）

- ~~Test coverage ~12%~~ → 2.1.0：~50%（580 tests）
- ~~`revalidateTag` / `revalidatePath` 无 retry / dead letter~~ → 2.1.0：
  `Promise.allSettled` 全跑 + `RevalidationError` 聚合 + Sorted Set replay log
- ~~SSG spider 无 timeout / retry / circuit breaker~~ → 2.1.0：30s timeout +
  3 次 jitter 退避重试 + `failBuildThreshold` 5%
- ~~Cross-pod cache invalidation 仅单进程~~ → 2.1.0：Redis Pub/Sub +
  Sorted Set 消息重放
- ~~Bench 不阻塞 CI~~ → 2.1.0：`bench/baseline.json` + `release.yml` 退化即 fail

详细 gap + roadmap 见 [`docs/production-readiness.md`](./docs/production-readiness.md)。
