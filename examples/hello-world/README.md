# hello-world

最小化的 isr-engine 消费者示例。演示**全部 4 条渲染路径**。

## 4 条渲染路径

isr-engine 暴露 **3 个用户可选 mode** + **1 个内部 fallback**：

| 路径 | 触发 | 演示路由 |
|---|---|---|
| **ISR** (cached + 后台 revalidate) | 默认全局，高读路径首选 | `/` (TTL 60s) |
| **SSG** (build-time 静态 HTML) | 内容低频 + SEO 强依赖 | `/about` |
| **SSR** (每次请求渲染) | 实时数据，不缓存 | `/health` |
| **csr-shell** (fallback) | **server 崩溃自动兜底，不是用户配置项** | 见下文 |

类型上：

```ts
// engine 公共类型
type RenderModeType = 'ssg' | 'isr' | 'ssr';   // ← 用户能选这 3 个

// 每条 mode 都有内部 FallbackChain，末端永远是 csr-shell：
//   isr → ['cached', 'regenerate', 'server', 'csr-shell']
//   ssg → ['static',  'regenerate', 'server', 'csr-shell']
//   ssr → ['server',  'csr-shell']
//
// 即任何模式都能在 server 不可用时，自动给浏览器送一个 SPA 壳 HTML，由前端自救。
```

## 文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | deps: `@novel-isr/engine`（走 `file:../..` 直链；真实项目用语义版本号 `^2.2.0`） |
| `vite.config.ts` | 把 `createIsrPlugin()` 挂进 vite，**唯一必须的接入点** |
| `ssr.config.ts` | 路由级 mode（全局 ISR + `/about` SSG + `/health` SSR） |
| `tsconfig.json` | 标配 TS |
| `src/entry.server.tsx` | `defineSiteHooks` 服务端 hooks（本例只挂静态 SEO） |
| `src/app.tsx` | 根 App = Server Component，用 `cacheTag` 注册 ISR 失效标签 |

## 跑起来

```bash
# 1. 装依赖
pnpm install

# 2. 开发 (热更新, dev mode)
pnpm dev                          # → http://localhost:3000

# 3. 生产构建 (会同时输出 ISR/SSG/csr-shell 三类产物)
pnpm build
ls dist/                          # 看 client/ + spa/ + server/

# 4. 生成纯 SPA 壳 (csr-shell 兜底用)
pnpm fallback                     # 输出 dist/spa/index.html

# 5. 起生产
pnpm start                        # → http://localhost:3000
```

## 验证 4 条路径都在工作

```bash
# ISR: 第 1 次 MISS, 第 2 次 HIT, 60s 后 STALE + 后台 revalidate
curl -sI http://localhost:3000/        | grep x-cache-status   # MISS
curl -sI http://localhost:3000/        | grep x-cache-status   # HIT

# SSG: 不进 ISR cache, 直接走 express.static (磁盘 HTML)
curl -sI http://localhost:3000/about   | grep x-cache-status   # BYPASS (磁盘静态)
ls dist/client/about/index.html                                 # 构建产物在这

# SSR: 永远 BYPASS, 每次响应都是新渲染
curl -sI http://localhost:3000/health  | grep x-cache-status   # BYPASS

# csr-shell: 看 fallback 产物
cat dist/spa/index.html                                         # 浏览器自救用的 SPA 壳
# 触发 fallback: 当 server 渲染抛错时, engine 把 dist/spa/index.html 直接返给客户端
# 浏览器拿到 shell 后自行 hydrate, 不会白屏
```

## 真实项目注意

- `"@novel-isr/engine": "file:../.."` → 换成 `"@novel-isr/engine": "^2.2.0"`
- 配 `.npmrc` 指向私有 npm registry（参考 isr-engine 仓的 `.npmrc.example`）
- 部署前读 [docs/deployment.md](../../docs/deployment.md)（HTTP/2 / Edge / 多 pod 失效广播）
- 多 pod 部署接 Redis：[docs/caching.md](../../docs/caching.md)（L2 + Pub/Sub 失效广播）

## 想看更复杂的

- bench fixture（含动态 route + 多 path）：[bench/fixture/](../../bench/fixture/)
- 全套接入指南：[docs/getting-started.md](../../docs/getting-started.md)
- 每个 hook 怎么挂：[docs/site-hooks.md](../../docs/site-hooks.md)
