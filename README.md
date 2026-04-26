# @novel-isr/engine

> Vite + React 19 RSC 的 ISR / SSG / Fallback 编排层。基于 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) 官方插件——**不手写 Flight 协议**。用户只写一个 `src/app.tsx`，其余全部由 engine 默认提供。

[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF.svg)](https://vitejs.dev/) [![React 19](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/) [![Node 22.21.1](https://img.shields.io/badge/Node-22.21.1-339933.svg)](https://nodejs.org/)

## 30 秒看明白

```bash
pnpm add @novel-isr/engine react react-dom
pnpm add -D vite typescript @types/react @types/react-dom
```

3 个文件：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';
export default defineConfig({ plugins: [...createIsrPlugin()] });
```

```jsonc
// package.json
{
  "scripts": {
    "dev": "novel-isr dev",
    "build": "vite build",
    "start": "novel-isr start"
  }
}
```

```tsx
// src/app.tsx —— 你需要写的唯一应用代码
export function App({ url }: { url: URL }) {
  return (
    <html><body><h1>Hello, {url.pathname}</h1></body></html>
  );
}
```

`pnpm dev` → http://localhost:3000。完事。

完整的「getting started」（含 i18n / SEO / Server Actions）请看 **[docs/getting-started.md](./docs/getting-started.md)**。

## 核心卖点

```
┌──────────────────────────────────────────────────────┐
│  用户写的代码（业务）                                 │
│    src/app.tsx                ← UI + 路由              │
│    src/pages/, components/    ← 业务组件               │
│    src/actions/               ← Server Actions         │
│    src/entry.server.tsx       ← (可选) SiteHooks 配置   │
│    ssr.config.ts              ← (可选) 路由级渲染模式  │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│  Engine（默认提供，零配置）                           │
│    • RSC fetch handler（@vitejs/plugin-rsc）          │
│    • SSR HTML 转换（react-dom/server.edge）           │
│    • 浏览器水合 / 客户端导航 / Server Action 调用     │
│    • ISR 缓存（LRU + SWR + 标签失效）                 │
│    • SSG spider（构建期预生成）                       │
│    • SEO sitemap / robots / OG image                  │
│    • i18n URL 路由 + 翻译消息加载                     │
│    • A/B 实验、限流、PII 审计                          │
│    • csr-shell fallback（server 崩溃自救）            │
│    • Sentry / Datadog / OTel adapter（一行接入）       │
│    • Image / Font 优化插件（next-style）              │
└──────────────────────────────────────────────────────┘
```

**真正甩开 Next.js 的优势**：
- Vite 8 dev HMR（不是 Webpack/Turbopack）
- 单 Express 进程，可 hack 中间件链
- 全部 SEO 在一个声明式对象里，不散在 metadata exports
- L1+L2 hybrid cache（进程内 LRU + 可选 Redis 写穿）
- A/B 变体、PII redaction、audit log 内建
- 显式 `RenderModeType = 'ssg' | 'isr' | 'ssr'`，不靠隐式 segment config

## 性能 benchmark

测试环境：MacBook M-series · Node 22 · 单进程 · 1000 req @ 10 并发

| 路径 | 模式 | QPS | p50 | p95 | p99 |
|---|---|---|---|---|---|
| `/` | ISR HIT | **9 804** | 1ms | 2ms | 6ms |
| `/books/1` | ISR HIT（含 RSC 树反序列化） | **5 405** | 1ms | 13ms | 18ms |
| `/?mode=ssr` | SSR（完整 RSC + SSR 管线） | **461** | 20ms | 36ms | 48ms |

复现：`pnpm bench`。详细解释与多核估算见 [docs/performance.md](./docs/performance.md)。

## 文档

按主题查：

| 主题 | 文档 |
|---|---|
| 从零搭一个站 | [getting-started.md](./docs/getting-started.md) |
| 渲染模式（ISR / SSR / SSG / csr-shell） | [render-modes.md](./docs/render-modes.md) |
| 缓存与失效（cacheTag / revalidate / Redis 双层） | [caching.md](./docs/caching.md) |
| SiteHooks 配置（i18n / SEO / Sentry / 限流） | [site-hooks.md](./docs/site-hooks.md) |
| i18n URL 路由 + 语言协商 | [i18n.md](./docs/i18n.md) |
| 可观测性（Sentry / Datadog / OTel / Prometheus） | [observability.md](./docs/observability.md) |
| 生产部署（环境变量 / Docker / Edge runtime / Middleware） | [deployment.md](./docs/deployment.md) |
| 验证 RSC 是否真的隐藏 server 代码 | [rsc-testing.md](./docs/rsc-testing.md) |
| 排错与常见坑 | [troubleshooting.md](./docs/troubleshooting.md) |
| SOC2 readiness | [security/SOC2-readiness.md](./docs/security/SOC2-readiness.md) |
| SSR/SPA 失效降级链路 | [deployment/ssr-spa-failover.md](./docs/deployment/ssr-spa-failover.md) |

## 渲染模式（一句话）

| 模式 | 行为 | 用户级可选 |
|---|---|---|
| **isr** | 显式 TTL，过期 SWR 回放 + 后台重渲。命中即入缓存。 | ✅ |
| **ssr** | 永不入缓存，每次跑完整 RSC + SSR 管线。 | ✅ |
| **ssg** | 构建期 spider 预生成磁盘 HTML，运行期 TTL × 24。 | ✅ |
| `csr-shell` | server 崩溃时返回壳 HTML，浏览器自救拉 `_.rsc`。 | ❌（自动兜底） |

```
FallbackChain（自动降级）：
  isr  → cached → regenerate → server → csr-shell
  ssg  → static → regenerate → server → csr-shell
  ssr  →                       server → csr-shell
```

详情：[docs/render-modes.md](./docs/render-modes.md)。

## 与业界方案对比

| 能力 | Next.js App Router | Waku | RedwoodJS | **isr-engine** |
|---|---|---|---|---|
| RSC 双 entry 模型 | ✅ 自实现 | ✅ plugin-rsc | ✅ 自实现 | ✅ plugin-rsc |
| ISR 缓存层 | ✅ | ❌ | ⚠️ | ✅ |
| `revalidatePath` / `revalidateTag` | ✅ | ⚠️ 实验 | ❌ | ✅ |
| `cacheTag` 精准失效 | ✅ | ❌ | ❌ | ✅ |
| 路由级 mode 配置 | ⚠️ segment config | ❌ | ❌ | ✅ ssr.config.ts |
| zero-config 入口 | ⚠️ 必须用 app/ 文件夹 | ✅ | ⚠️ | ✅ src/app.tsx |
| csr-shell server 崩溃兜底 | ❌ | ❌ | ❌ | ✅ |
| 构建栈灵活度 | ❌ 绑死自家栈 | ✅ Vite | ❌ 绑死自家栈 | ✅ Vite |
| 内置图片 / 字体优化 | ✅ | ❌ | ⚠️ | ✅ |
| Edge runtime 支持 | ✅ | ⚠️ | ❌ | ✅（CF / Vercel / Deno / Bun） |
| 单元测试覆盖 | 数千用例 | ⚠️ | ✅ | 22 文件（仍需提升覆盖） |

定位：**中等规模业务的 ISR / SSG / Fallback 编排层**，构建于 React 19 + `@vitejs/plugin-rsc` 官方流水线之上。

## 生产可用性诚实评估

**Beta-ready**，不是 production-recommended。

✅ **稳的部分**：
- Flight 协议委托给官方 `@vitejs/plugin-rsc@^0.5.24`，不自维护
- 依赖全是工业级（Express / Helmet / Prometheus / sitemap / lru-cache / ioredis）
- 性能数量级合理（HIT 9.8K QPS / SSR 461 QPS 单核）
- 观测齐全（trace-id / render-ms / X-Cache-Status 自动注入）

⚠️ **生产前你必须知道的事**：
- 测试覆盖仍偏低（22 测试文件），race condition / HTTP e2e 路径还需继续补
- `revalidateTag` / `revalidatePath` 已聚合错误并抛 `RevalidationError`，调用方仍需要显式处理失败反馈
- SSG spider 已有 timeout / retry / fail threshold，但还缺大型真实站点的长期构建数据
- Cross-pod cache invalidation 已支持 Redis Pub/Sub，但不是持久化队列；Redis 维护窗口内仍可能丢事件
- HTTP/2 / HTTP/3 origin 直出仍需你的代理链路矩阵压测；生产推荐 CDN/Nginx/Caddy 终止协议
- Bench 不阻塞 CI，性能可能悄悄退化

详细 gap 列表与改造建议：[docs/production-readiness.md](./docs/production-readiness.md)。

## 开发

```bash
pnpm install
pnpm test                # vitest run
pnpm test:coverage       # 覆盖率报告
pnpm lint                # eslint
pnpm type-check          # tsc --noEmit
pnpm bench               # autocannon load test（不阻塞）
pnpm bench:compare       # 与 baseline diff
pnpm check               # type-check + lint + format:check + test
pnpm build               # vite build → dist/
```

### 关于 `pnpm.overrides` 警告

`isr-engine/package.json` 里的 `pnpm.overrides` 把 `path-to-regexp` 锁到 `0.1.13`（与 express 4.21 兼容；不锁会被解析到 8.x 导致 `pathRegexp is not a function`）。

**始终在 `isr-engine/` 目录内执行 pnpm 命令**，override 会正常生效，无任何警告。

仅当从 `isr-engine/` 外的父目录跑 `pnpm ls -r` 等递归命令时，pnpm 会打：

```
WARN The field "pnpm.overrides" was found in .../isr-engine/package.json.
     This will not take effect. You should configure "pnpm.overrides" at
     the root of the workspace instead.
```

这是 pnpm 的 false positive —— **本仓库不是 workspace**，父目录只是文件夹聚合。该警告对实际安装行为无影响（已通过 `pnpm ls express` 验证 express 拿到的是 0.1.13）。

如果觉得碍眼，要么不在父目录跑 `-r` 命令，要么 `pnpm ls -r 2>/dev/null` 屏蔽 stderr。

## 设计原则

1. **约定优于配置** —— 用户唯一必需文件是 `src/app.tsx`
2. **第一性原理** —— 不造假概念（csr 不是用户级 mode，是 fallback 兜底）
3. **横切能力 engine 默认提供** —— trace-id / render-ms / SEO / 安全头自动
4. **业务扩展用 FaaS hooks** —— 不强制学协议代码
5. **不手写 Flight** —— 完全依赖 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)，与 React 19 / Vite 8 升级路径对齐

## License

MIT
