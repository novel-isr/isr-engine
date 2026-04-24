# Render Modes

Engine 暴露 3 个**用户级**渲染模式 + 1 个**自动兜底**模式。

| 模式 | TTL 行为 | 何时入缓存 | 用户可选 |
|---|---|---|---|
| **isr** | 显式 TTL，过期 SWR 回放 + 后台重渲 | 命中即入 | ✅ |
| **ssr** | 不缓存 | 永不入缓存（BYPASS） | ✅ |
| **ssg** | TTL × 24（极长），生产期 spider 预生成磁盘 HTML | 构建时 + 运行时按需补 | ✅ |
| `csr-shell` | server 崩溃时返回壳 HTML，浏览器 createRoot 自救拉 `_.rsc` | 不入缓存 | ❌（FallbackChain 末端，自动） |

## FallbackChain（自动降级）

```
isr  → cached → regenerate → server → csr-shell
ssg  → static → regenerate → server → csr-shell
ssr  →                       server → csr-shell
```

任何模式下 server 崩溃都能走到 `csr-shell`：返回一个壳 HTML，浏览器立即 createRoot 自救，调 `<path>_.rsc` 拉真实数据填充。详细行为见 [deployment/ssr-spa-failover.md](./deployment/ssr-spa-failover.md)。

## ISR（默认）

**Incremental Static Regeneration**：第一次请求实时渲染 + 入缓存；TTL 内命中即返回；TTL 过期后进入 SWR 窗口（先回放旧内容 + 后台重渲）。

```ts
// ssr.config.ts
{
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
  }
}
```

- `ttl: 60` —— 60 秒内 HIT
- `staleWhileRevalidate: 300` —— 60-360 秒内继续返回旧内容，但后台重渲新版本
- 360 秒后 → MISS 重渲

## SSR

每次请求跑完整 RSC + SSR 管线，**不缓存**。适合：登录页、个性化数据、表单提交结果。

```ts
{ routes: { '/login': 'ssr' } }
```

`X-Cache-Status: BYPASS`。

## SSG

**Static Site Generation**：构建期由 spider 预生成 HTML 到 `dist/client/<path>/index.html`，运行时优先返回静态文件。

```ts
{
  routes: { '/about': 'ssg' },
  ssg: { routes: ['/about'], concurrent: 3 },
}
```

构建期：`vite build` 的 `closeBundle` 钩子自动 spider 一遍 `ssg.routes` 列表。
运行时：默认 TTL × 24（极长），相当于"几乎永不过期"。需要更新就重新部署。

> **注意**：SSG spider 当前没有 retry / timeout / circuit breaker。单页 fetch 失败可能拖累整个 build phase（`continueOnError` 默认 true 但日志没强制 fail-loud）。生产前建议 staging 跑一遍 1000+ route 的全量 spider 验证稳定性。

## csr-shell（自动兜底）

**不是用户级 mode**，是 FallbackChain 末端。当 server 渲染抛异常 / 超时 / OOM 时：

1. Engine 返回 `200 OK` 的壳 HTML（含必要的 client bundle reference）
2. `X-Render-Strategy: csr-shell` header
3. 浏览器立即 hydrate 一个降级 UI（"服务端暂时不可用，正在尝试客户端加载…"）
4. 自动调 `<path>_.rsc` 拉真实数据填充

效果：**用户看到的是慢一点的页面，不是 5xx**。

测试方法：

```tsx
// 临时在 app.tsx 顶部加：
if (url.searchParams.get('__crash') === '1') throw new Error('test');
```

```bash
curl -I 'http://localhost:3000/?__crash=1'
# HTTP/1.1 200 OK
# x-render-strategy: csr-shell
```

## 模式切换 query param（dev only）

任何路由加 `?mode=isr|ssr|ssg|csr` 可以临时覆盖配置（仅 dev）：

```bash
curl -sSI 'http://localhost:3000/?mode=ssr'
# X-Resolved-Mode: ssr
# X-Mode-Source: query-override
```

便于 staging 排查"这个页慢是 cache miss 还是 SSR 慢"。

## 怎么选？

| 场景 | 选 |
|---|---|
| 首页、文章详情、商品页（数据慢变） | **isr** |
| About、Help、纯静态 marketing 页 | **ssg** |
| 登录、Dashboard、用户面板 | **ssr** |
| 对延迟敏感但允许少许过期 | **isr** + 短 TTL + 长 SWR |
| 必须实时一致 | **ssr** |

不确定时选 **isr**——它能覆盖 80% 业务路由。
