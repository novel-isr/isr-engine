# hello-world

最小化的 isr-engine 消费者示例。**6 个文件**跑起 ISR + SSG + Server Component。

## 文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `@novel-isr/engine` 依赖（这里走 `file:../..` 直链 isr-engine 源；真实项目用语义版本号 `^2.2.0`） |
| `vite.config.ts` | 把 `createIsrPlugin()` 挂进 vite，**唯一必须的接入点** |
| `ssr.config.ts` | 路由级渲染模式（全局 ISR + `/about` SSG + `/health` SSR） |
| `tsconfig.json` | 标配 TS 配置 |
| `src/entry.server.tsx` | 服务端 hooks（SEO / i18n / 限流等都在这里挂；本示例只挂静态 SEO） |
| `src/app.tsx` | 根 App 是个 Server Component，用 `cacheTag` 注册 ISR 失效标签 |

## 跑起来

```bash
# 在 hello-world 目录
pnpm install
pnpm dev          # 访问 http://localhost:3000

# 生产构建
pnpm build && pnpm start
```

## 验证 ISR 真在工作

```bash
# 第 1 次 GET / → MISS (走渲染)
curl -sI http://localhost:3000/ | grep -i x-cache-status   # X-Cache-Status: MISS

# 第 2 次（60s 内）→ HIT (毫秒返回)
curl -sI http://localhost:3000/ | grep -i x-cache-status   # X-Cache-Status: HIT

# 验证 SSG: /about 访问任何次数都不进 ISR cache（已是磁盘静态 HTML）
curl -sI http://localhost:3000/about | grep -i content-type  # text/html
```

## 比这个例子更复杂的场景

- 多页路由 + lazy split：`bench/fixture/` 演示了 `/`、`/about`、`/books/:id` 三类路由
- 业务真实项目：参考 [docs/getting-started.md](../../docs/getting-started.md)
- 各种 hook 怎么挂：[docs/site-hooks.md](../../docs/site-hooks.md)
- ISR 缓存 / SWR / cacheTag 全套机制：[docs/caching.md](../../docs/caching.md)

## 真实项目注意

- 把 `"@novel-isr/engine": "file:../.."` 换成 `"@novel-isr/engine": "^2.2.0"`
- 配 `.npmrc` 指向你的私有 npm registry（参考 isr-engine 仓的 `.npmrc.example`）
- 部署前读一遍 [docs/deployment.md](../../docs/deployment.md)（HTTP/2 / Edge runtime / 多 pod 失效广播等）
