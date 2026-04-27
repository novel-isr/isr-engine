# @novel-isr/engine

> Vite + React 19 RSC 的 ISR / SSG / Fallback 编排层。基于 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) 官方插件——**不手写 Flight 协议**。用户只写一个 `src/app.tsx`，其余全部由 engine 默认提供。

[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF.svg)](https://vitejs.dev/) [![React 19](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/) [![Node 22.21.1](https://img.shields.io/badge/Node-22.21.1-339933.svg)](https://nodejs.org/) [![Tests 580](https://img.shields.io/badge/Tests-580%20passing-brightgreen.svg)](./CHANGELOG.md)

> **v2.2.0 unreleased** —— ISR 缓存层 5 项性能 / 内存 / 运维优化：cache key 版本化命名空间、MISS 回源 single-flight、capture buffer OOM 防御、HIT 边缘预热、CPU-aware prerender 并发。完全向后兼容，零破坏性。详见 [CHANGELOG.md](./CHANGELOG.md)。

> **通用框架，跨项目复用**。任何 Vite + React 19 + RSC 站点都可以接，不绑定特定业务。仅在私有 git/registry 发布，不发 public（`prepublishOnly` 校验 `NPM_REGISTRY_URL` 指向内部 host，避免误发）。

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

baseline：[`bench/baseline.json`](./bench/baseline.json) —— 由 [`scripts/bench-fixture/`](./scripts/bench-fixture/)
（self-contained 最小 ISR 应用）跑出。MacBook M-series · Node 22 · 单进程 ·
3s warmup · 8s/tier · 2s cooldown · `BENCH_DISABLE_RATE_LIMIT=1`：

| 路径 | 模式 | QPS @ 10c | QPS @ 10000c | P95 @ 10c | P95 @ 10000c |
|---|---|---|---|---|---|
| `/` | ISR + cacheTag | **24 826** | 1 486 | 3.3ms | 1712ms |
| `/about` | SSG (express.static) | **63 362** | 7 040 | 0ms | 524ms |
| `/books/1` | ISR + tag-based | **46 065** | 2 984 | 1.3ms | 1030ms |

复现：`pnpm bench`（生产 baseline）/ `cd scripts/bench-fixture && pnpm start` 后跑
`pnpm bench`（开发 baseline）。CI bench gate 见 [`.github/workflows/bench.yml`](./.github/workflows/bench.yml)：
退化 P95 +20% 或 QPS -15% 自动 fail。详细解释见 [docs/performance.md](./docs/performance.md)。

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
| 单元测试覆盖 | 数千用例 | ⚠️ | ✅ | 41 文件 / 580 tests / ~50% |

定位：**中等规模业务的 ISR / SSG / Fallback 编排层**，构建于 React 19 + `@vitejs/plugin-rsc` 官方流水线之上。

## 生产可用性诚实评估

**v2.2.0 后 production-eligible**（中等规模业务）。v2.1 完成 Security & Reliability 硬化，v2.2 在 ISR 缓存层加上 single-flight / OOM 防御 / 命名空间失效 / 边缘预热 / CPU-aware 并发 5 项工业级优化。

✅ **稳的部分**：
- Flight 协议委托给官方 `@vitejs/plugin-rsc@^0.5.24`，不自维护
- 依赖全是工业级（Express / Helmet / Prometheus / sitemap / lru-cache / ioredis）
- 580 tests / ~50% 覆盖；CI 任何分支 push 都跑 lint+typecheck+test
- bench 退化检测纳入 CI（`P95 +20%` 或 `QPS -15%` 自动 block PR / publish）
- 私有 npm 发布有 4 段 gate（lint+test+build+bench），任一失败 → 不发布
- 安全硬化覆盖了 Set-Cookie 跨用户回放、SSG 路径穿越、Redis Buffer 破损、
  Pub/Sub 消息丢失等 10 项审计发现项

⚠️ **生产前你仍需知道的事**：
- HTTP/2 / HTTP/3 origin 直出仍需你的代理链路矩阵压测；生产推荐 CDN/Nginx/Caddy 终止协议
- 私有 npm 发布需配 `NPM_REGISTRY_URL` + `NPM_TOKEN` GitHub Secrets；不发 public registry
- bench baseline 在自家 CI 硬件上首次跑后提交，跨机器对比无意义（绝对值仅参考）

完整改动列表：[CHANGELOG.md](./CHANGELOG.md)。

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

## 与消费者解耦

`@novel-isr/engine` 不发 public npm，只发**私有 registry**（如公司内 Verdaccio /
npm Enterprise / GitHub Packages）。**任何项目**都可以作为消费方接它，通过语义
化版本号引用，**不**用 `file:../isr-engine` 这种 sibling 相对路径——sibling 假设
让两个 repo 互相强耦合，CI checkout 也跑不通。

**消费侧 install 步骤**（任何项目通用）：

```bash
# 1. 配 .npmrc（一次性）
@novel-isr:registry=https://npm.your-company.com/
//npm.your-company.com/:_authToken=${NPM_TOKEN}

# 2. package.json 里写语义版本号
{ "dependencies": { "@novel-isr/engine": "^2.2.0" } }

# 3. install
pnpm install
```

**联动开发**（一边改 engine 一边在某个消费项目里迭代，不用每次发版）：

```bash
# engine 端
cd isr-engine && pnpm build && pnpm link --global

# 任何消费项目端
cd <YOUR_CONSUMER_PROJECT> && pnpm link --global @novel-isr/engine
# 改完取消 link
pnpm unlink --global @novel-isr/engine && pnpm install
```

## CI / 发布

仓库里 3 个 workflow 各司其职：

| Workflow | 触发 | 跑什么 | 失败后果 |
|---|---|---|---|
| **`ci.yml`** | 任何分支 push + PR 到 main/develop | type-check / lint / format / test (580) / build | branch 标红，PR 不可 merge |
| **`bench.yml`** | nightly 02:00 UTC + 手动 + perf-sensitive 路径 PR | 起 bench-fixture + 跑 bench + 对比 `bench/baseline.json` | P95 +20% 或 QPS -15% → fail |
| **`release.yml`** | `git push v*.*.*` tag | 全部 4 段 gate（type+lint / test / build / bench）→ `pnpm publish --access restricted` 到私有 npm | 任一段失败 → 不发布 |

**发布到私有 npm**：

1. Repo `Settings → Secrets and variables → Actions` 配置：
   - `NPM_REGISTRY_URL` —— 例如 `https://npm.your-company.com/`
   - `NPM_TOKEN` —— 对应 registry 的 read-write token
2. 本地：
   ```bash
   # 改 package.json version 到 X.Y.Z
   git tag vX.Y.Z
   git push --tags
   ```
3. GitHub Actions 自动跑 release.yml；任一 gate 失败 → 不发布。

**公网 npm**：本仓库 **不发 public**（`pnpm publish --access restricted`）。

## 设计原则

1. **约定优于配置** —— 用户唯一必需文件是 `src/app.tsx`
2. **第一性原理** —— 不造假概念（csr 不是用户级 mode，是 fallback 兜底）
3. **横切能力 engine 默认提供** —— trace-id / render-ms / SEO / 安全头自动
4. **业务扩展用 FaaS hooks** —— 不强制学协议代码
5. **不手写 Flight** —— 完全依赖 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)，与 React 19 / Vite 8 升级路径对齐

## License

MIT
