# Performance

## Bench 数据

测试环境：MacBook M-series · Node 22 · 单进程 · 多档并发（10 / 100 / 1000 / 10000）·
3s warmup / 8s per tier / 2s cooldown · `BENCH_DISABLE_RATE_LIMIT=1`：

| 路径 | 模式 | QPS @ 10c | QPS @ 10000c | P95 @ 10c | P95 @ 10000c |
|---|---|---|---|---|---|
| `/` | ISR + cacheTag | **24 826** | 1 486 | 3.3ms | 1712ms |
| `/about` | SSG (express.static) | **63 362** | 7 040 | 0ms | 524ms |
| `/books/1` | ISR + tag-based | **46 065** | 2 984 | 1.3ms | 1030ms |

数量级评估：

- **SSG** 是 `express.static` 直发磁盘 HTML，单核 ~60K QPS 是合理上限
- **ISR HIT** 走 LRU 内存查询 + Buffer 写出，~25-46K QPS 取决于 entry 大小
- **加 4 核 / Cluster**：QPS ×4 几乎线性

baseline：[`bench/baseline.json`](../bench/baseline.json) ——
由 [`bench/fixture/`](../bench/fixture/) 跑出。

## 复现命令

```bash
pnpm bench               # autocannon load test，多档并发
node bench/compare.mjs bench/baseline.json bench-result.json   # 与 baseline diff
```

`bench/runner.mjs` 用 [autocannon](https://github.com/mcollina/autocannon) 跑 HTTP load
test 并写出 `bench-result.json`。`bench/compare.mjs` 解析输出做 baseline 对比。

## CI bench gate

`release.yml` 第 4 闸门 + `bench.yml`（nightly + perf-sensitive 路径 PR）生效：
P95 +20% 或 QPS -15% 任意一档触发即 fail-fast。详见 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

## 常见性能问题

### ISR 永远 MISS

- 检查 `markUncacheable()` 是否被调（错误页 / 上游 fetch 失败时）
- 检查 `X-Cache-Status` 是不是 `BYPASS`（可能某个 cookie 触发了"个性化 → 不缓存"）

### SSR 慢

- 看 `x-render-ms`，定位是渲染慢还是上游 fetch 慢
- 看 `/metrics` 的 `isr_http_request_duration_seconds` 直方图
- 上游 fetch 用 `createCachedFetcher` 加 LRU + dedupe，避免重复打 API

### 内存涨停

- L1 LRU 默认 `max: 1000`。如果业务路由组合（含 query string）多于这个，会频繁 evict
- 看 Prometheus `isr_cache_entries{backend}`，长期接近 L1 容量就该调大或上 Redis L2
- Prometheus `isr_process_*` 看 RSS 走势

## 性能调优手段

| 改动 | 收益 | 成本 |
|---|---|---|
| 路由全 ISR + 适中 TTL | 90% 流量走 LRU 命中 | 数据延迟最大 = TTL + SWR 窗口 |
| 加长 SWR 窗口 | 高峰时 SWR 兜底 = 不会 thundering MISS | 旧数据时间窗变长 |
| 加 Redis L2 | 多 pod 共享缓存，冷启动快 | 多一跳网络（< 1ms 同 region） |
| Cluster mode | QPS 接近线性扩展 | 每 worker 独立 L1；启用 Redis Pub/Sub 后失效可广播，但事件非持久化 |
| `<Image>` priority | 首屏 LCP 提升 | 牺牲非首屏带宽 |
| `createFontPlugin` Google Fonts 自托管 | LCP -200~400ms | 构建时多下载 |

## 与业界数字对比

参考点（同等 hardware，用社区公开 benchmark）：
- **Next.js 14 App Router**：ISR HIT ~6-8K QPS（实测因配置而异）
- **Waku**：SSR ~600 QPS（无 ISR 缓存层）
- **本 engine**：ISR HIT ~25K / SSG ~60K

差异主要来自：
- ISR HIT 高一档：纯 LRU + Buffer 直写，不走 Next 的 fetch cache 抽象
- SSR 同档：底层都是 React 19 `react-dom/server.edge`，瓶颈相同
