# Troubleshooting

## 常见症状速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 改了 Server Component 不生效 | RSC env HMR 偶尔失效 | `Ctrl+C` 重启 dev + `rm -rf node_modules/.vite` |
| `Cannot read 'useState'` 等怪异水合错 | 双 React 实例（engine 与 app 解析到不同副本） | 已自动 dedupe；如仍出现，删 `node_modules/.vite` 重启 |
| `Identifier 'RefreshRuntime' has already been declared` | 装了 `@vitejs/plugin-react` | 卸载它（plugin-rsc 已内置） |
| `/sitemap.xml` 500 | `SEO_BASE_URL` 未设 | dev 自动兜底；prod 必须注入环境变量 |
| ISR 永远 MISS / 不进缓存 | 上游 API 失败，Server Component 调了 `markUncacheable` | 修复上游或不调 markUncacheable |
| SSR 一直显示 `BYPASS` | 正常行为；SSR 每次实时渲染，永不写页面缓存 | 不需要修；用 ISR/SSG 才会 HIT |
| dev inspector 里 i18n 是 `local-fallback` | admin/API 未启动、`ADMIN_API_URL` 不对，或远端返回非 2xx | 启动 admin/API，确认 `entry.server.tsx` 的 `api` / `load` 指向正确 |
| 想关闭右下角浮层但写在 `entry.server.tsx` 无效 | 浮层是浏览器 client runtime 能力 | 在 `src/entry.tsx` 写 `export default { devInspector: false }` |
| 端口被占 | 上次 SIGINT 没清干净 | `kill $(lsof -tiTCP:3000)` |
| 多 pod `revalidateTag` 部分 pod 不生效 | Redis Pub/Sub 未启用、频道不一致，或 Redis 维护窗口期间消息丢失 | 确认所有 pod 使用同一 `REDIS_URL` / `invalidationChannel`；保留较短 L1 TTL 作为补偿 |
| `revalidateTag` 调了但缓存没清 | fire-and-forget 回调静默失败 | 包 `try { await revalidateTag(...) } catch` 抓异常 |
| SSG build 卡住或 OOM | spider 单页超时未设上限 | 临时减少 `ssg.routes` 数量；或调 `ssg.concurrent` 降低并发 |

## 诊断命令

### 看请求实际走了哪条 fallback

```bash
curl -I http://localhost:3000/some-page
# 关注：
# X-Cache-Status: HIT|MISS|STALE|BYPASS
# X-Resolved-Mode: isr|ssr|ssg
# X-Render-Strategy: csr-shell    ← 只有 server 崩溃才出现
# Content-Language: zh
# X-I18n-Source: admin|local-fallback
```

### 看缓存大小

```bash
curl http://localhost:3000/__isr/stats
# {"size": 234, "max": 1000, "revalidating": 2}
```

prod 模式默认关闭，需要 `ISR_ADMIN_TOKEN`：

```bash
curl -H "x-isr-admin-token: $ISR_ADMIN_TOKEN" \
     http://localhost:3000/__isr/stats
```

### 强制清缓存

```bash
curl -X POST -H "x-isr-admin-token: $ISR_ADMIN_TOKEN" \
     http://localhost:3000/__isr/clear
```

### 看 Prometheus

```bash
curl http://localhost:3000/metrics | head -40
```

## 验证 RSC 真的隐藏了 server 代码

见 [rsc-testing.md](./rsc-testing.md)。

## 验证 csr-shell 兜底真的工作

```tsx
// 临时在 app.tsx 顶部加：
if (url.searchParams.get('__crash') === '1') throw new Error('test');
```

```bash
curl -I 'http://localhost:3000/?__crash=1'
# HTTP/1.1 200 OK              ← 不是 5xx
# x-render-strategy: csr-shell ← engine 兜底
```

浏览器看到："服务端暂时不可用，正在尝试客户端加载…" 然后立刻自动调 `_.rsc` 拉真实数据填充。

## 仍卡住？

- 跑 `pnpm check`（type-check + lint + tests）排除环境问题
- 看 `logs/` 目录的 trace（engine 自动写的）
- 提 issue 时附：完整命令输出 + `pnpm --version` + `node --version` + `cat package.json | grep '@novel-isr'`
