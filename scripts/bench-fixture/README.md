# bench-fixture

最小可启动的 ISR fixture —— 专供 CI bench 用。**不是 demo**，目标是用最少业务代码
覆盖 engine 的所有关键渲染路径，让 bench 测出来的 QPS / P95 直接对应 engine
中间件的真实性能。

## 路由

| 路径          | 模式 | 测什么                                        |
| ------------- | ---- | --------------------------------------------- |
| `/`           | ISR  | HIT/MISS/STALE 全链路 + cacheTag('items')     |
| `/about`      | SSG  | express.static 直发 + 构建期预生成            |
| `/books/:id`  | ISR  | 动态参数 + cacheTag('books', 'book:<id>')     |
| `/api/health` | SSR  | 不缓存路径（每次跑 RSC 管线）                 |

## 设计原则

1. **零远端依赖**：所有"动态数据"内联，避免上游 API 抖动污染 bench 数据
2. **依赖 engine 自家入口**：`createIsrPlugin` + `defineSiteHooks` —— bench 路径
   与生产用户路径一致，不走简化版 mock 服务器
3. **挂上 rateLimit + experiments**：验证 `BENCH_DISABLE_RATE_LIMIT=1` 真能绕过
   限流 + variant cookie 不污染 ISR cache key

## 用法（CI 自动跑；手动也能跑）

```bash
cd scripts/bench-fixture
pnpm install --frozen-lockfile
pnpm run build
BENCH_DISABLE_RATE_LIMIT=1 PORT=3000 pnpm start
# 另一终端
cd ../..
BENCH_TIERS=10,100,1000 pnpm run bench
```

## CI 集成

`.github/workflows/bench.yml` 的 fixture 步骤直接 `cd scripts/bench-fixture` →
build → start。**不再依赖 sibling 业务项目**（`novel-rating-website`），所以 bench
job 在任何 fork / 任何 GitHub Actions checkout 都能跑。

## 为什么 ssr.config.ts 在这里而不是 root

isr-engine 仓库 root 有自己的 `ssr.config.example.ts`（给消费者参考用，不会被
engine 自己加载）。bench-fixture 是真正"消费 engine 的 app"，它的 ssr.config.ts
就放在自己目录下，与 engine 完全解耦。
