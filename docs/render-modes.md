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

开发态没有生产构建产物，所以不会假装从 `dist/client` 返回静态文件；但路由策略解析、
响应头和 dev inspector 展示都走同一套 engine 决策链。验证真正的磁盘静态产物要跑
`pnpm build && pnpm start`。

SSG spider 内置 retry / timeout / 失败率门槛 —— 单页 fetch 失败不会静默吞掉整个 build：

- `ssg.requestTimeoutMs`（默认 30_000）—— 单页超时
- `ssg.maxRetries`（默认 3）—— timeout / network / 5xx 自动重试，4xx 不重试
- `ssg.retryBaseDelayMs`（默认 200）—— 指数退避起点
- `ssg.failBuildThreshold`（默认 0.05）—— 整体失败率超 5% → build fail

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

任何路由加 `?mode=isr|ssr|ssg` 可以临时覆盖配置（仅 dev）。`csr-shell` 不接受
`mode=csr` 触发，因为 CSR 不是用户级渲染模式；开发态可用 `?__csr-shell=1`
强制验证 fallback 壳。

```bash
curl -sS -D - 'http://localhost:3000/?mode=ssr' -o /dev/null
# X-Resolved-Mode: ssr
# X-Mode-Source: query-override
```

便于 staging 排查"这个页慢是 cache miss 还是 SSR 慢"。

## Novel ISR Inspector（dev only）

开发模式下 engine 会自动注入右下角 **Novel ISR Inspector**。它读取真实响应头，
不 mock、不伪造：

- `X-Resolved-Mode`：`isr` / `ssr` / `ssg`
- `X-Render-Strategy`：`rsc-ssr` / `csr-shell`
- `X-Cache-Status`：`HIT` / `MISS` / `STALE` / `BYPASS`
- `X-Fallback-Used`：是否进入 fallback
- `Content-Language` + `X-I18n-Source`：i18n locale 和字典来源

浮层切换只改当前 URL 的调试参数，不跳转到其它业务页面。SSR 显示 `BYPASS`
是正确语义，因为 SSR 永不写页面缓存。详细见 [dev-inspector.md](./dev-inspector.md)。

## 怎么选？

| 场景 | 选 |
|---|---|
| 首页、文章详情、商品页（数据慢变） | **isr** |
| About、Help、纯静态 marketing 页 | **ssg** |
| 登录、Dashboard、用户面板 | **ssr** |
| 对延迟敏感但允许少许过期 | **isr** + 短 TTL + 长 SWR |
| 必须实时一致 | **ssr** |

不确定时选 **isr**——它能覆盖 80% 业务路由。
