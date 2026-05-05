# @novel-isr/engine

> Vite + React 19 RSC 的 ISR / SSG / Fallback 编排层。基于 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) 官方插件——**不手写 Flight 协议**。业务只维护一个 `routes` 路由源、一个 `App` 壳和可选的 `SiteHooks` 配置，其余 SSR / ISR / SSG / CSR recovery 协议细节全部由 engine 收口。

[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF.svg)](https://vitejs.dev/) [![React 19](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/) [![Express 5](https://img.shields.io/badge/Express-5-000000.svg)](https://expressjs.com/) [![Node 22.21.1](https://img.shields.io/badge/Node-22.21.1-339933.svg)](https://nodejs.org/) [![Tests 551](https://img.shields.io/badge/Tests-551%20passing-brightgreen.svg)](./CHANGELOG.md)

> **v2.3.1（2026-04-29）** —— 消费侧首跑 0 配置：修复 `import React from 'react'`
> 在 React 19 ESM 下导致浏览器报 `does not provide an export named 'default' / 'jsxDEV'`
> 的兼容缺陷；express 4 → 5（移除 `path-to-regexp` 兼容 hack）；
> 子路径 exports 部分迁移到 `dist/`，业务侧 `vite.config.ts` 不再需要任何
> `optimizeDeps.include` 兜底。详见 [CHANGELOG.md](./CHANGELOG.md#231---2026-04-29)。

> **通用框架，与业务无关**。任何 Vite + React 19 + RSC 站点都可以接。
> 包名前缀 `@novel-isr` 仅是首发项目代号，与小说业务**无任何耦合**——
> grep 全仓源码无业务硬编码，运行时无业务假设。发到 GitHub Packages
> （restricted），不发 public registry；项目仍处于 **alpha** 阶段（详见末尾「生产可用性诚实评估」）。

## 30 秒看明白

```bash
# engine + 必需的 peer 依赖（react-server-dom-webpack / rsc-html-stream 给 RSC 流水线用，
# 严格 pnpm 模式下必须显式装）
pnpm add @novel-isr/engine react react-dom react-server-dom-webpack rsc-html-stream
pnpm add -D vite typescript @types/react @types/react-dom
```

生产推荐接入（含单 routes、API i18n 与 SEO 下发）：

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
// src/routes.tsx —— 业务唯一路由源；SSR/ISR/SSG/CSR recovery 都复用这一份
import { defineRoutes } from '@novel-isr/engine/runtime';

export const { routes } = defineRoutes({
  notFound: { load: () => import('./pages/NotFoundPage') },
  routes: [
    { path: '/', load: () => import('./pages/HomePage') },
    { path: '/books/:id', load: () => import('./pages/BookDetailPage') },
    { path: '/about', load: () => import('./pages/AboutPage') },
  ],
});
```

```tsx
// src/app.tsx —— App 只负责站点壳和调用 routes；不用 i18n 时可直接传 url.pathname
import { parseLocale, resolveI18nConfig } from '@novel-isr/engine/runtime';
import siteHooks from './entry.server';
import { routes } from './routes';

const I18N = resolveI18nConfig(siteHooks.intl);

export function App({ url }: { url: URL }) {
  const { locale, pathname } = parseLocale(url.pathname, I18N);
  return (
    <html lang={locale}>
      <body>{routes({ pathname, searchParams: url.searchParams })}</body>
    </html>
  );
}
```

```ts
// ssr.config.ts —— 启动期 / 部署期 / 平台级配置
import { defineIsrConfig } from '@novel-isr/engine';
import fallbackLocal from './src/config/site-fallback-local.json';

export default defineIsrConfig({
  renderMode: 'isr',
  runtime: {
    site: process.env.SEO_BASE_URL ?? 'http://localhost:3000',
    services: {
      api: process.env.API_URL ?? 'http://localhost:8080',
      i18n: process.env.I18N_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
      seo: process.env.SEO_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
      telemetry: process.env.TELEMETRY_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
    },
    redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL, keyPrefix: 'isr:' } : undefined,
    telemetry: {
      app: 'novel-rating',
      events: { endpoint: '/api/observability/analytics' },
      errors: { endpoint: '/api/observability/errors' },
      integrations: {
        sentry: {
          enabled: process.env.SENTRY_ENABLED === 'true',
          dsn: process.env.SENTRY_DSN,
        },
      },
    },
    rateLimit: {
      windowMs: 60_000,
      max: 200,
      trustProxy: process.env.TRUST_PROXY === '1',
      sendHeaders: true,
    },
    experiments: {
      'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
    },
    i18n: {
      locales: fallbackLocal.site.locales,
      defaultLocale: fallbackLocal.site.defaultLocale,
      endpoint: '/api/i18n/{locale}/manifest',
      fallbackLocal: fallbackLocal.i18n.strings,
      ttl: 60_000,
    },
    seo: {
      endpoint: '/api/seo?path={pathname}',
      fallbackLocal: fallbackLocal.seo.entries,
      ttl: 60_000,
    },
  },
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': 'ssg',
    '/login': 'ssr',
    '/*': 'isr',
  },
  ssg: { routes: ['/about'] },
  isr: { revalidate: 3600 },
  cache: { strategy: 'memory', ttl: 3600 },
});
```

```ts
// src/entry.server.ts —— 可选：只放请求期 hooks，例如用户、租户、分层、错误上报
import { defineAdminSiteHooks, readCookie } from '@novel-isr/engine/site-hooks';

export default defineAdminSiteHooks({
  beforeRequest: req => ({
    userId: req.headers.get('x-user-id') ?? readCookie(req, 'uid') ?? undefined,
    tenantId: req.headers.get('x-tenant-id') ?? 'public',
  }),
  onError: (err, req, ctx) => {
    console.error('[render error]', { traceId: ctx.traceId, url: req.url, err });
  },
});
```

`beforeRequest` 返回值会进入当前请求的 `RequestContext`。Server Component 里用
`getRequestContext()` 读取用户、租户、分群等请求级字段；Client Component 需要由
Server Component 读取后作为 props 传入。A/B variant 不在 `beforeRequest` 里手写解析，
页面用 `getVariant()` 读取，engine 负责 sticky cookie 和 ISR variant 缓存隔离。
完整用法见 [docs/site-hooks.md](./docs/site-hooks.md#beforerequest--onerror)。

`pnpm dev` → http://localhost:3000。开发模式会自动注入 **Novel ISR Inspector** 浮层，
可直接切换/验证 ISR、SSR、SSG、CSR fallback。业务不需要 import 调试组件。
如需隐藏浮层，新建 `src/entry.tsx`：

```ts
export default {
  devInspector: false,
};
```

浏览器埋点和错误上报由 engine 内置收口，业务不用重写导航监听或全局错误监听。
部署期只在 `ssr.config.ts` 配 telemetry endpoint、采样、批量策略和 integration：

```ts
// ssr.config.ts
export default {
  runtime: {
    services: {
      telemetry: process.env.TELEMETRY_API_URL ?? 'https://admin.example.com',
    },
    telemetry: {
      app: 'novel-rating',
      release: process.env.APP_VERSION,
      environment: process.env.NODE_ENV,
      includeQueryString: false,
      events: {
        endpoint: '/api/observability/analytics',
      },
      errors: {
        endpoint: '/api/observability/errors',
        captureResourceErrors: true,
      },
      webVitals: { enabled: true },
      integrations: {
        sentry: {
          enabled: process.env.SENTRY_ENABLED === 'true',
          dsn: process.env.SENTRY_DSN,
          tracesSampleRate: 0.1,
          environment: process.env.NODE_ENV,
        },
      },
    },
  },
};
```

设计边界：`isr-engine` 不 import 业务 SDK，也不绑定 Sentry/Datadog/自研采集端；
第一方 HTTP 链路只看 `events.endpoint` / `errors.endpoint`，不再在 exporter 里重复配置同一个地址。
Sentry 是
`runtime.telemetry.integrations.sentry` 里的完整第三方平台集成，不降级成普通 HTTP exporter；
它可和第一方 endpoint 同时使用，也可通过关闭 `events/errors` 做二选一。
engine 不做隐式替换，失败不会影响渲染或其它上报。
`@novel-isr/analytics` 和 `@novel-isr/error-reporting`
是独立 SDK，给非 engine 应用或自定义集成使用。
完整说明见 [docs/observability.md](./docs/observability.md)。

完事。

完整的「getting started」（含 i18n / SEO / Server Actions）请看 **[docs/getting-started.md](./docs/getting-started.md)**。

## 核心卖点

```
┌──────────────────────────────────────────────────────┐
│  用户写的代码（业务）                                 │
│    src/routes.tsx             ← 唯一路由源              │
│    src/app.tsx                ← App shell + routes 调用 │
│    src/pages/, components/    ← 业务组件               │
│    src/actions/               ← Server Actions         │
│    src/entry.server.tsx       ← (可选) 请求期 hooks     │
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
│    • page-level SEO + API SEO 下发                    │
│    • i18n URL 路由 + 字典缓存 + getI18n()              │
│    • A/B testing、限流                                 │
│    • csr-shell fallback（server 崩溃自救）            │
│    • dev render inspector（开发态渲染模式浮层）        │
│    • browser analytics / error-reporting 生命周期桥接 │
│    • Sentry / Datadog / OTel adapter（一行接入）       │
│    • Image / Font 优化插件（next-style）              │
└──────────────────────────────────────────────────────┘
```

**真正甩开 Next.js 的优势**：
- Vite 8 dev HMR（不是 Webpack/Turbopack）
- 单 Express 进程，可 hack 中间件链
- SEO 在 page export + runtime.seo 下发层分层收口，不散落到组件渲染树
- L1+L2 hybrid cache（进程内 LRU + 可选 Redis 写穿）
- A/B 变体、限流内建
- 显式 `RenderModeType = 'ssg' | 'isr' | 'ssr'`，不靠隐式 segment config

## 性能 benchmark

baseline：[`bench/baseline.json`](./bench/baseline.json) —— 由 [`bench/fixture/`](./bench/fixture/)
（self-contained 最小 ISR 应用）跑出。MacBook M-series · Node 22 · 单进程 ·
3s warmup · 8s/tier · 2s cooldown · `BENCH_DISABLE_RATE_LIMIT=1`：

| 路径 | 模式 | QPS @ 10c | QPS @ 10000c | P95 @ 10c | P95 @ 10000c |
|---|---|---|---|---|---|
| `/` | ISR + cacheTag | **24 826** | 1 486 | 3.3ms | 1712ms |
| `/about` | SSG (express.static) | **63 362** | 7 040 | 0ms | 524ms |
| `/books/1` | ISR + tag-based | **46 065** | 2 984 | 1.3ms | 1030ms |

复现：`pnpm bench`（生产 baseline）/ `cd bench/fixture && pnpm start` 后跑
`pnpm bench`（开发 baseline）。bench 退化追踪走 [`.github/workflows/bench.yml`](./.github/workflows/bench.yml)
nightly 信息性输出（GitHub hosted runner 跨次硬件不一致 ±60%，不能拿来 gate
release）。详细：[docs/performance.md](./docs/performance.md)。

## 文档

按主题查：

| 主题 | 文档 |
|---|---|
| 从零搭一个站 | [getting-started.md](./docs/getting-started.md) |
| 渲染模式（ISR / SSR / SSG / csr-shell） | [render-modes.md](./docs/render-modes.md) |
| 开发态渲染检查器（Novel ISR Inspector） | [dev-inspector.md](./docs/dev-inspector.md) |
| 缓存与失效（cacheTag / revalidate / Redis 双层） | [caching.md](./docs/caching.md) |
| SiteHooks 配置（beforeRequest / i18n / SEO / A/B） | [site-hooks.md](./docs/site-hooks.md) |
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

## 开发态渲染检查器

`pnpm dev` 时，engine 默认 client runtime 会自动注入右下角 **Novel ISR Inspector**。
它属于 engine，不属于业务 UI：

- 通过响应头读取 `x-resolved-mode`、`x-render-strategy`、`x-cache-status`、`x-fallback-used`、`content-language`、`x-i18n-source`
- 可以在当前 URL 上切换 `?mode=isr|ssr|ssg`，或强制 `?__csr-shell=1` 验证 CSR fallback
- Shadow DOM 隔离样式，不污染业务 CSS
- 仅 dev 显示，生产不显示

如果业务要关闭它，放到 **client entry**：

```ts
// src/entry.tsx
export default {
  devInspector: false,
};
```

不要放到 `src/entry.server.tsx`。`entry.server.tsx` 是 server hooks，不能把 server-only
配置直接透给浏览器；需要跨端公共配置时应该走 `ssr.config.ts` 或 engine 注入的 client-safe
public config。详见 [docs/dev-inspector.md](./docs/dev-inspector.md)。

## Routes / SEO / i18n 标准写法

### Routes：业务只写一个源

`defineRoutes({ routes, notFound })` 是业务唯一需要维护的路由声明。不要在业务项目里再拆 `routes.ssr`、`routes.spa`、`spaModules`、`ssrModules` 或手写 loader 分支。第一性原理很简单：一条路由只应该对应一棵 RSC tree，ISR / SSR / SSG / CSR recovery 的执行策略是 engine 的职责。

```tsx
import { defineRoutes } from '@novel-isr/engine/runtime';

export const { routes } = defineRoutes({
  notFound: { load: () => import('./pages/NotFoundPage') },
  routes: [{ path: '/', load: () => import('./pages/HomePage') }],
});
```

### Page SEO：页面声明默认值，API 可覆盖

页面模块可以导出静态 `seo` 或动态 `seo(ctx)` / `generateSeo(ctx)`。Engine 会在 server entry 里先加载 i18n，再解析 page SEO，因此页面 SEO 里可以直接调用 `getI18n()`。

```tsx
// src/pages/BookDetailPage.tsx
import { getI18n } from '@novel-isr/engine/runtime';

export async function seo({ params }: { params: { id: string } }) {
  const book = await fetchBook(params.id);
  return {
    title: getI18n('seo.book.title', { title: book.title }),
    description: book.summary,
    ogType: 'book',
    image: book.cover,
  };
}

export default async function BookDetailPage() {
  // ...
}
```

`runtime.seo` 用来接 API / CMS 下发的 SEO：`endpoint`、`ttl`、`fallbackLocal`
都放在 `ssr.config.ts`。`entry.server.tsx` 不承载 SEO 数据源配置，只负责本次请求的
用户、租户、分层和错误上报。

合并顺序：`page seo` 提供页面默认值，`SiteHooks seo` 提供远端覆盖值；最终 `<title>`、`meta`、canonical、Open Graph、JSON-LD 都由 engine 注入到 SSR HTML 的 `<head>`，业务组件里不需要手写 `<title>` / `<meta>`。

### i18n：服务端拉取一次，RSC payload 复用

商业项目推荐由 API 下发字典。`runtime.i18n` 统一声明 `locales`、`defaultLocale`、
`endpoint`、`ttl`、`fallbackLocal`；engine 会生成请求期 loader，页面不需要写 Provider。

业务侧统一用 `getI18n(key, params?, fallback?)`，不需要手写 Provider。

```tsx
import { getI18n } from '@novel-isr/engine/runtime';

getI18n('home.hero.title');
getI18n('book.count', { count: 12 }); // 字典里写 "共 {count} 本书"
```

变量占位符是 `{name}`，不是 `$name`。例如：

```json
{
  "book": {
    "count": "共 {count} 本书",
    "rating": "{title} 评分 {score}"
  }
}
```

性能路径：
- SSR / ISR / SSG：server 端按 cookie `locale` → `Accept-Language` → `defaultLocale` 协商 locale，远程字典走 TTL + SWR + 并发去重缓存；同一份 `intl` 进入 RSC payload，客户端水合不二次拉取。
- 客户端导航：浏览器拉 `_.rsc`，payload 带最新 `intl`，engine 自动更新 `getI18n()` 的客户端存储。

### rateLimit：默认 memory，显式 Redis 才分布式

`runtime.rateLimit` 是站点入口的应用层保护。默认 `store: 'memory'`，状态在当前
Node 进程的 LRU 中，重启清空，多 pod 不共享；不会因为配置了 `runtime.redis` 就隐式改成
Redis 限流。

要开启分布式限流：

```ts
runtime: {
  redis: { url: process.env.REDIS_URL, keyPrefix: 'novel:' },
  rateLimit: {
    store: 'redis',
    windowMs: 60_000,
    max: 200,
    trustProxy: true,
    sendHeaders: true,
    keyPrefix: 'novel:rate-limit:',
  },
}
```

- `windowMs`：固定窗口长度，单位毫秒。`60_000` 表示 1 分钟。
- `max`：同一个 key 在一个窗口内允许的最大请求数。默认 key 是客户端 IP。
- `trustProxy`：只在可信 CDN/LB/Nginx 后面开启，否则客户端可伪造代理头。
- `sendHeaders`：返回 `RateLimit-*` 和 `Retry-After` 标准头。
- 默认跳过 `/health`、`/metrics`、`OPTIONS`、静态资源扩展名，以及 dev 下的 Vite/module 请求；业务可用 `skipPaths` / `skipPathPrefixes` / `skipExtensions` 补充内部探针或自定义资源路径。
- Redis store 使用 Lua 原子递增 + TTL；Redis 故障时 fail-open 放行，不拖垮业务入口。
- CSR recovery：engine 默认 RSC shell fallback 会先 fetch 当前页面 `_.rsc`，拿到 `intl` 后再渲染页面；业务不再需要维护第二套路由或自定义 CSR App。
- 服务端完全不可用且 `_.rsc` 也失败时，只会显示最终不可用壳；这时没有远程 i18n，因为数据源本身不可达。
- 诊断：响应头 `x-i18n-source` 会显示字典来源，例如 `admin` / `local-fallback`。

## 与业界方案对比

| 能力 | Next.js App Router | Waku | RedwoodJS | **isr-engine** |
|---|---|---|---|---|
| RSC 双 entry 模型 | ✅ 自实现 | ✅ plugin-rsc | ✅ 自实现 | ✅ plugin-rsc |
| ISR 缓存层 | ✅ | ❌ | ⚠️ | ✅ |
| `revalidatePath` / `revalidateTag` | ✅ | ⚠️ 实验 | ❌ | ✅ |
| `cacheTag` 精准失效 | ✅ | ❌ | ❌ | ✅ |
| 路由级 mode 配置 | ⚠️ segment config | ❌ | ❌ | ✅ ssr.config.ts |
| zero-config 入口 | ⚠️ 必须用 app/ 文件夹 | ✅ | ⚠️ | ✅ routes + app.tsx |
| csr-shell server 崩溃兜底 | ❌ | ❌ | ❌ | ✅ |
| 构建栈灵活度 | ❌ 绑死自家栈 | ✅ Vite | ❌ 绑死自家栈 | ✅ Vite |
| 内置图片 / 字体优化 | ✅ | ❌ | ⚠️ | ✅ |
| Edge runtime 支持 | ✅ | ⚠️ | ❌ | ✅（CF / Vercel adapter；Deno / Bun 走原生 `{fetch}`） |
| 单元测试覆盖 | 数千用例 | ⚠️ | ✅ | 44 文件 / 564 tests / ~50% |

定位：**中等规模业务的 ISR / SSG / Fallback 编排层**，构建于 React 19 + `@vitejs/plugin-rsc` 官方流水线之上。

## 生产可用性诚实评估

**当前阶段：alpha** —— 单一首发项目（novel-rating）在自用，外部用户尚未 burn-in。
v2.1 做了 Security & Reliability 硬化，v2.2 加了 ISR 缓存层 single-flight /
OOM 防御 / 命名空间失效 / 边缘预热 / CPU-aware 并发 5 项工业级优化，
v2.3.1 收口了消费侧首跑 0 配置 + express 5 + 入口架构清理。但**离 1.0 stable 还差**：

✅ **稳的部分**：
- Flight 协议委托给官方 `@vitejs/plugin-rsc@^0.5.24`，不自维护
- 依赖全是工业级（Express 5 / Helmet / Prometheus / sitemap / lru-cache / ioredis）
- 564 tests / ~50% 覆盖；CI 任何分支 push 都跑 lint+typecheck+test
- bench 退化追踪走 nightly `bench.yml`（信息性输出，不 gate release）
- GitHub Packages 发布有 3 段 gate（lint+test+build），任一失败 → 不发布
- 安全硬化覆盖了 Set-Cookie 跨用户回放、SSG 路径穿越、Redis Buffer 破损、
  Pub/Sub 消息丢失等 10 项审计发现项
- 消费侧首跑 0 配置：v2.3.1 后 `vite.config.ts` 三件套真的能跑起来（详见 CHANGELOG）

⚠️ **真上生产你必须知道**：
- **只有首发项目在用**，未在第二个独立项目里完整 burn-in 过；社区 review 才刚开始
- 浏览器侧没有持续跑的 e2e（543 测试主要是 Node 侧单测），靠人工
  smoke test。任何 React 19 / plugin-rsc / Vite 升级都需要先在 fixture 项目里手验
- Origin 协议只支持 `http1.1` / `https`；HTTP/2 / HTTP/3 应在 CDN / Nginx / Caddy / ALB 终结
- bench baseline 跨 GitHub hosted runner 硬件不一致（同 SHA 跑两次能飘 ±60% QPS），
  release 不 gate bench；要做 release-blocking bench gate 需自部 self-hosted runner 锁硬件
- API 在 v1.0 之前可能有破坏性变更，主要风险面：路由 `defineRoutes` 形态、
  `SiteHooks` 配置 schema、ISR cacheTag/revalidate API。会在 CHANGELOG 中
  明确标注 `BREAKING`，但**没有 codemod**。

完整改动列表：[CHANGELOG.md](./CHANGELOG.md)。

## 开发

```bash
pnpm install
pnpm test                # vitest run
pnpm lint                # eslint（含 prettier check via eslint-plugin-prettier）
pnpm type-check          # tsc --noEmit
pnpm bench               # autocannon load test（不阻塞）
pnpm check               # type-check + lint + test
pnpm build               # vite build → dist/
```

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
{ "dependencies": { "@novel-isr/engine": "^2.3.0" } }

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
| **`ci.yml`** | 任何分支 push + PR 到 main/develop | type-check / lint / test / build | branch 标红，PR 不可 merge |
| **`bench.yml`** | nightly 02:00 UTC + 手动 + perf-sensitive 路径 PR | 起 bench-fixture + 跑 bench + 对比 `bench/baseline.json` | 信息性 fail（不阻断 release，只用于追踪退化） |
| **`release.yml`** | `git push v*.*.*` tag | 3 段 gate（type+lint / test / build）→ `pnpm publish --access restricted` 到 GitHub Packages | 任一段失败 → 不发布 |

**发布到 GitHub Packages**：

1. 一次性配置：repo `Settings → Actions → General → Workflow permissions` 切到 **Read and write permissions**（让 `GITHUB_TOKEN` 拿到 `write:packages`）。无需手动配 secret。
2. 本地：
   ```bash
   # 改 package.json version 到 X.Y.Z
   git tag vX.Y.Z
   git push --tags
   ```
3. GitHub Actions 自动跑 release.yml；任一 gate 失败 → 不发布。

**消费侧**：见 [`.npmrc.example`](./.npmrc.example) 配 GitHub PAT (`read:packages` scope) → `pnpm install`.

**不发 public**：`pnpm publish --access restricted`，GitHub Packages 默认私有。

## 设计原则

1. **约定优于配置** —— 业务只维护一个 `routes` 源和一个 `App` 壳
2. **第一性原理** —— 不造假概念（csr 不是用户级 mode，是 fallback 兜底）
3. **横切能力 engine 默认提供** —— trace-id / render-ms / SEO / 安全头自动
4. **业务扩展用 FaaS hooks** —— 不强制学协议代码
5. **不手写 Flight** —— 完全依赖 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)，与 React 19 / Vite 8 升级路径对齐

## License

MIT
