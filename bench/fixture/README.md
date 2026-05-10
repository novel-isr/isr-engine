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
3. **故意不挂 experiments / 远端 SEO**：这些 hook 会写 Set-Cookie 或触发远端
   fetch，让 ISR 中间件按设计 skip 缓存或引入网络抖动，污染 bench 数据。
   它们的正确性由 `src/middlewares/__tests__/` 单元测试覆盖。

## 用法（CI 自动跑；手动也能跑）

```bash
cd bench/fixture
pnpm install --no-frozen-lockfile
pnpm run build
PORT=3000 pnpm start
# 另一终端
cd ../..
BENCH_TIERS=10,100,1000 pnpm run bench
```

bench runner 默认打 `http://127.0.0.1:3000`，避免 `localhost` 在高并发下同时解析
IPv6/IPv4 后把操作系统连接抖动计入 engine 性能结果。

CI 会设置 `BENCH_RUNNER_ID=github-actions-ubuntu-latest-x64-node22`。`bench/compare.mjs`
只会比较同一 bench protocol + 同一 runner class 的 raw QPS/P95；旧 baseline 或本地机器
生成的 baseline 会被判定为不可比较，只保留 non-2xx / errors 等健康门槛。

## CI 集成

`.github/workflows/bench.yml` 的 fixture 步骤直接 `cd bench/fixture` → build → start。
**不依赖 sibling 业务项目**，bench job 在任何 fork / 任何 GitHub Actions checkout 都能跑。
