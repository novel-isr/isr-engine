# Production Readiness

诚实评估 + 改造 roadmap。

## 当前判定：Beta

**可以用在**：
- 内部业务做灰度和 staging 验证
- < 1k QPS 的 SSR 场景
- 静态/ISR 主导的内容站
- 自托管 Node 平台

**不要用在**（除非自己改造）：
- 大规模 SaaS（10k+ QPS 单 pod 的多租户 SSR，未做过压测验证）
- 零停机 rolling deploy（graceful shutdown 未做压测）
- 多 region failover（Redis cross-DC 同步未文档化）
- SOC2 / HIPAA 合规生产（框架本身只是组件，详见 [security/SOC2-readiness.md](./security/SOC2-readiness.md)）

## ✅ 已就绪

- **核心管线稳定**：基于 Vite 8 官方 + plugin-rsc 官方，RSC / SSR / Flight 协议代码不自维护
- **生产构建链路通**：本仓库内 `pnpm vite build` / `pnpm test` 可通过
- **性能数量级合理**：HIT 9.8K QPS / SSR 461 QPS（单核），p99 < 50ms
- **观测基础齐全**：trace-id / render-ms / cache-status 头自动注入；`/__isr/stats` JSON 端点；Prometheus `/metrics`
- **优雅关闭**：SIGINT/SIGTERM 处理，3s 超时强制退出
- **SEO**：sitemap.xml + robots.txt 自动生成，baseUrl 多级解析
- **安全头**：helmet 默认 + 严格 CSP（详见 SOC2 readiness 文档）
- **PII redaction**：审计日志自动 redact email/phone/JWT/AWS key/GitHub token
- **Hybrid cache**：L1 进程内 LRU + 可选 L2 Redis 写穿
- **Edge runtime adapter**：CF Workers / Vercel Edge / Deno / Bun

## ⚠️ Gap 列表（生产前你需要知道的）

| Gap | 影响 | 当前状态 |
|---|---|---|
| Test coverage ~12%（17 tests / 141 src files）| race / 边界路径未覆盖 | P0 |
| Bench 不阻塞 CI | 性能退化无门槛 | P0 |
| `revalidateTag/Path` fire-and-forget | 回调抛错丢失，并发顺序未定义 | P0 |
| SSG spider 无 retry/timeout/circuit breaker | 单页失败可能拖累整个 build | P0 |
| Redis 写 async fire-and-forget，无持久化 queue | Pod 重启丢写 | P1 |
| Cross-pod cache invalidation 已有 Redis Pub/Sub，但不是持久化队列 | Redis 短故障期间事件可能丢失 | P1 |
| HTTP/2/HTTP/3 origin 直出未做生产矩阵压测 | 代理链路、ALPN、长连接行为仍需验证 | P1 |
| `no-explicit-any: 'warn'` | 框架库应该 `'error'` | P0 |
| **生产部署案例 / SLO 数据** | 没人在生产跑过 | 你将是第一个；先内部业务灰度 1-2 周 |
| **Partial Prerendering** 暂无 | 部分静态 + 部分流式混合，需自己设计 | 路线图 |
| **Middleware/路由拦截器** 简易版 | i18n 重写、A/B 自己做 | `middleware.ts` 已支持，需自写逻辑 |

## 改造优先级（建议路线图）

### P0 — 上生产前必修

✅ **已完成（v2.0.x）**：

1. ✅ **`revalidate.ts` fire-and-forget 已修复** — `Promise.allSettled` 跑完所有 invalidator；任意失败聚合成 `RevalidationError` 抛出（`src/rsc/revalidate.ts`）。每次失败递增 `isr_invalidator_failures_total{kind}` 指标。默认行为是异常向上传播（安全 default）；想静默失败的 Server Action 显式包 `try/catch`。详见 [caching.md#失败语义](./caching.md#失败语义v20x-起)。
2. ✅ **SSG spider 已加固**（`src/ssg/spider.ts`）：
   - 单页 timeout（默认 30s）
   - 重试（默认 3 次，指数退避 200/400/800ms，只重试 timeout/network/5xx）
   - 整体失败率 > 5% 抛 `SsgBuildFailedError`，即使 `continueOnError = true` 也强制 fail build
   - 全部参数可在 `ssr.config.ts` 的 `ssg: {...}` 覆盖
3. ✅ **lint 升级** — `@typescript-eslint/no-explicit-any: 'error'`（`src/defaults/**` 和配置文件除外）。
4. ✅ **ISREngine 生命周期集成测试** — `src/__tests__/lifecycle.integration.test.ts`：覆盖 cache + invalidator 协作 / tag & path 失效 / 并发 revalidate / 单 invalidator 失败不污染 registry / register-unregister 无泄漏。

⏳ **进行中**：

5. ⏳ **Bench CI gate** — `scripts/bench-compare.mjs` 和 `.github/workflows/bench.yml` 已就位，对比 baseline 退化 > 20% (P95) / 15% (QPS) 即 fail。**待办**：
   - 提交首个 `scripts/bench-baseline.json`（在你的目标 hardware 上跑一次基准）
   - 长期方案：在 `scripts/bench-fixture/` 做最小独立 server，避免依赖 sibling `novel-rating-website`

   首次生成 baseline：
   ```bash
   pnpm vite build && pnpm novel-isr start &
   BENCH_OUTPUT=scripts/bench-baseline.json pnpm bench
   git add scripts/bench-baseline.json && git commit -m "bench: seed baseline"
   ```

### P1 — 一周内做（成熟度跨档）

6. ✅ **多 pod invalidator**：已有 Redis Pub/Sub 传播失效事件；仍需在你的 staging 多 pod 环境验证断线重连、事件丢失补偿和 Redis 维护窗口行为。
7. **测试覆盖率冲到 ≥ 30%**：补 race condition、SSG 错误、cache stampede 防护测试。
8. **文档分主题拆分** ✅ 已完成（你在看的就是）
9. **真正的 ISREngine HTTP e2e 测试**：当前 `cache-invalidator.integration.test.ts` 验证的是 cache + invalidator 协作（中间件层），**没有**起 Express server / 跑 RSC handler。补一个 fixture entry.server.tsx + `ISREngine.start()` → curl 真请求 → `revalidateTag` → 再请求验证清缓存 → `shutdown()` 的全链路 e2e。需要 ~30 分钟 + 一个最小 fixture。也是 bench CI 的前置依赖（`scripts/bench-fixture/`，跟 #5 共用）。

### P2 — 让框架真正成熟（2-4 周）

9. **代码清理** ✅ 部分完成（src/server → src/actions、resolveI18nConfig 抽取）
10. **scaffold CLI**：`pnpm create novel-isr-app my-app` 生成最小可跑模板。
11. **edge runtime 探索**：写 ADR 决定 Vercel/CF 是否作为一等支持。
12. **CHANGELOG + 自动化版本（changesets）**

## 推荐内部使用前 checklist

- [x] 单元测试：vitest 已接入（`pnpm test` / `pnpm test:coverage`）
- [x] 性能回归：`pnpm bench` 多档并发；CI 阻断仍需单独补 workflow
- [x] 缓存可观测性：`/metrics` Prometheus + `/__isr/stats` JSON
- [x] 多 Pod 缓存一致性：`createHybridCacheStore({ redis })` 双层缓存
- [ ] 跑一周以上的预发环境压测，监控内存增长
- [ ] 设置 `SEO_BASE_URL` 环境变量到真实域名
- [ ] 接入 Sentry / Datadog / OTel（一行 `createXxxServerHooks`）
- [ ] 完成 P0 5 项（见上）

## 跟 Next.js 的成熟度差距（诚实说）

| 维度 | Next.js | isr-engine |
|---|---|---|
| Adopters | 数百万 | ~1（这个仓库） |
| StackOverflow 答案 | 数十万 | 0 |
| 文档完整度 | 极高 | 中（你在看的就是） |
| Edge runtime 一等支持 | ✅ | ⚠️ adapter 存在但未深度测试 |
| 测试覆盖 | 数千用例 | 17 文件 |
| `next/image` 兼容 | — | ❌ API 不同 |
| Vercel 一键部署 | ✅ | ❌ |

**承认这些差距不是为了否定 engine 的价值**——它的价值在 Vite 速度、可 hack 的 Express、单文件 SEO 配置上。如果你 100% 要 Next 生态宽度，用 Next；如果你要 Vite 体验和更小的运行时表面积，可以用 engine 但要预算自己的运维投入。
