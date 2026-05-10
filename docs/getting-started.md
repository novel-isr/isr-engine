# Getting Started

从零搭一个 `@novel-isr/engine` 站，10 分钟。

## 1. 装依赖

```bash
mkdir my-app && cd my-app
pnpm init
# engine + RSC 流水线 peer 依赖
pnpm add @novel-isr/engine react react-dom react-server-dom-webpack rsc-html-stream
pnpm add -D vite typescript @types/react @types/react-dom @types/node
```

> `react-server-dom-webpack` / `rsc-html-stream` 是 engine 的 raw subpath export（如 `@novel-isr/engine/server-entry`）和 `@vitejs/plugin-rsc` 共同消费的 peer dep —— 严格 pnpm 模式下必须显式装。

> **不要再装 `@vitejs/plugin-react`** —— `@vitejs/plugin-rsc`（engine 内部用）已内置 React Refresh + JSX 处理；重复注册会报 `RefreshRuntime has already been declared`。

## 2. `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';

export default defineConfig({
  plugins: [...createIsrPlugin()],
});
```

## 3. `package.json` 脚本

```jsonc
{
  "scripts": {
    "dev": "novel-isr dev",
    "build": "vite build",
    "start": "novel-isr start"
  }
}
```

`build` 直接走 `vite build` —— isr-engine 是运行时编排层，不接管构建系统。SSG 预渲染由 `createIsrPlugin` 的 `closeBundle` 钩子自动触发。

## 4. `src/routes.tsx` —— 业务唯一路由源

```tsx
import { defineRoutes } from '@novel-isr/engine/runtime';

export const { routes } = defineRoutes({
  notFound: { load: () => import('./pages/NotFoundPage') },
  routes: [
    { path: '/', load: () => import('./pages/HomePage') },
    { path: '/books/:id', load: () => import('./pages/BookDetailPage') },
  ],
});
```

同一份 `routes` 会被 SSR / ISR / SSG / CSR recovery 复用。业务不要再维护 `routes.ssr`、`routes.spa`、`spaModules` 或 `ssrModules`。

## 5. `ssr.config.ts` —— 平台配置和渲染模式

```ts
import { defineIsrConfig } from '@novel-isr/engine/config';
import fallbackLocal from './src/config/site-fallback-local.json';

export default defineIsrConfig({
  renderMode: 'isr',
  runtime: {
    site: process.env.SITE_URL ?? 'http://localhost:3000',
    services: {
      api: process.env.API_URL ?? 'http://localhost:8080',
      telemetry: process.env.TELEMETRY_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
    },
    redis: {
      url: process.env.REDIS_URL,
      host: undefined,
      port: undefined,
      password: undefined,
      keyPrefix: 'isr:',
      invalidationChannel: 'isr:invalidate',
    },
    telemetry: {
      app: 'novel-rating',
      release: process.env.APP_VERSION,
      environment: process.env.NODE_ENV,
      includeQueryString: false,
      events: {
        endpoint: '/api/observability/analytics',
        trackInitialPage: true,
        sampleRate: 1,
        batchSize: 20,
        flushIntervalMs: 3000,
        maxQueueSize: 500,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 30000,
      },
      errors: {
        endpoint: '/api/observability/errors',
        captureResourceErrors: true,
        sampleRate: 1,
        batchSize: 10,
        flushIntervalMs: 3000,
        maxQueueSize: 200,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 30000,
      },
      webVitals: { enabled: true },
      exporters: [],
      integrations: { sentry: undefined },
    },
    experiments: {},
    i18n: {
      locales: fallbackLocal.site.locales,
      defaultLocale: fallbackLocal.site.defaultLocale,
      prefixDefault: false,
      endpoint: '/api/i18n/{locale}/manifest',
      fallbackLocal: fallbackLocal.i18n.strings,
      ttl: 60_000,
      timeoutMs: 1200,
      remoteSource: 'admin-server',
      fallbackSource: 'fallback-local',
    },
    seo: {
      endpoint: '/api/seo?path={pathname}',
      fallbackLocal: fallbackLocal.seo.entries,
      ttl: 60_000,
      timeoutMs: 1200,
    },
  },
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': 'ssg',
    '/login': 'ssr',
    '/*': 'isr',
  },
  server: {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST,
    strictPort: process.env.NODE_ENV !== 'development',
    ops: {
      authToken: process.env.ISR_OPS_TOKEN,
      tokenHeader: 'x-isr-admin-token',
      health: { enabled: true, public: true },
      metrics: { enabled: process.env.ENABLE_METRICS === '1', public: false },
    },
  },
  ssg: {
    routes: ['/about'],
    concurrent: 3,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },
  revalidate: 3600,
});
```

`ssr.config.ts` 是启动期单一配置入口。路由渲染模式、Redis、Sentry、限流、A/B、站点 URL 都放这里。
页面缓存后端不由业务配置；engine 自动选择 memory / Redis，TTL 放在 `routes[*].ttl` 或 `revalidate`。

## 6. `src/entry.server.ts` —— 请求期 SiteHooks

```ts
import { defineAdminSiteHooks, readCookie } from '@novel-isr/engine/site-hooks';

export default defineAdminSiteHooks({
  beforeRequest: req => ({
    userId: req.headers.get('x-user-id') ?? readCookie(req, 'uid') ?? undefined,
    tenantId: req.headers.get('x-tenant-id') ?? 'public',
    requestSegment: req.headers.get('x-segment') ?? 'default',
  }),
});
```

`runtime.i18n` / `runtime.seo` 描述如何加载 i18n / SEO。`entry.server.ts` 只保留
request context 和错误处理。`site` 和 `services` 只写在 `ssr.config.ts` 的 `runtime`，engine 会注入到默认 server entry，
避免同一项配置散落多处。i18n 字典和 SEO 都可以远程下发，engine 会做 TTL / SWR / 并发去重缓存。

`beforeRequest` 的返回值会进入当前请求的 `RequestContext`。页面里只在
Server Component / server-side helper 读取：

```tsx
import { getRequestContext } from '@novel-isr/engine/rsc';

export default async function HomePage() {
  const ctx = getRequestContext();
  const tenantId =
    typeof ctx?.tenantId === 'string' ? ctx.tenantId : 'public';

  // 有真实业务差异时才使用：租户级书库、运营位、主题、缓存隔离。
  const books = await fetch(`/api/books?tenant=${tenantId}`).then(r => r.json());
  return <BookGrid books={books.data} />;
}
```

Client Component 不能直接读 `getRequestContext()`。需要在 Server Component 中
读取后作为 props 传下去。不要为了“用上 tenantId”只打一个 cacheTag；如果页面
数据和 UI 都不随 tenant 变化，那就不要读取它。

A/B testing 不写在 `beforeRequest`。在 `ssr.config.ts runtime.experiments` 声明后，
页面使用 `getVariant('test-name')`；engine 负责 sticky cookie 和 ISR variant
缓存隔离。完整说明见 [site-hooks.md](./site-hooks.md#beforerequest--onerror)。

## 7. `src/app.tsx` —— App shell

```tsx
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

**契约**：`src/app.tsx` 必须 `export function App({ url }: { url: URL })`，返回完整的 `<html>` 树；`src/routes.tsx` 只负责声明页面入口。

## 8. 跑

```bash
pnpm dev                          # → http://localhost:3000
pnpm build && pnpm start          # 生产模式
```

完事。**无需写 entry.tsx / entry.ssr.tsx / 任何协议模板代码**，自动获得：
- 3 种渲染模式（ISR / SSR / SSG）+ csr-shell server 崩溃兜底
- LRU 缓存 + SWR + 标签级失效
- SEO `/sitemap.xml` / `/robots.txt`
- 自动注入 `x-trace-id` + `x-render-ms` 响应头
- dev render inspector（右下角模式/缓存/i18n 来源浮层）
- React 19 RSC 完整流水线

开发态浮层属于 engine，不需要业务 import。要关闭时才写 client entry：

```ts
// src/entry.tsx
export default {
  devInspector: false,
};
```

不要写到 `src/entry.server.tsx`；那个文件只负责 server hooks。详见
[dev-inspector.md](./dev-inspector.md)。

## 加 Server Components 和 Server Actions

```tsx
// src/pages/HomePage.tsx —— Server Component（无指令 = SSR-only）
import { cacheTag } from '@novel-isr/engine/rsc';

export default async function HomePage() {
  cacheTag('books');                                  // 声明依赖：revalidateTag('books') 时清除
  const books = await fetch('http://api/books').then(r => r.json());
  return <BookList books={books} />;
}
```

```tsx
// src/actions/books.ts —— Server Action
'use server';
import { revalidateTag } from '@novel-isr/engine/rsc';

export async function publishBook(data: FormData) {
  // ... write db
  await revalidateTag('books');                       // 精准清除所有声明了 'books' 的页面
}
```

```tsx
// src/components/PublishBookForm.tsx —— Client Component
'use client';
import { useState } from 'react';
import { publishBook } from '../actions/books';

export default function PublishBookForm() {
  const [name, setName] = useState('');
  return <form action={publishBook}>...</form>;
}
```

详细模式语义：[render-modes.md](./render-modes.md)。
缓存与失效：[caching.md](./caching.md)。

## 扩展平台配置（Redis / Telemetry / 限流 / A/B）

继续写在 `ssr.config.ts` 的 `runtime`：

```ts
// ssr.config.ts
export const runtime = {
  site: process.env.SITE_URL ?? 'http://localhost:3000',
  services: {
    api: process.env.API_URL ?? 'http://localhost:8080',
    telemetry: process.env.TELEMETRY_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
  },

  redis: {
    url: process.env.REDIS_URL,
    host: undefined,
    port: undefined,
    password: undefined,
    keyPrefix: 'isr:',
    invalidationChannel: 'isr:invalidate',
  },
  telemetry: {
    app: 'novel-rating',
    release: process.env.APP_VERSION,
    environment: process.env.NODE_ENV,
    includeQueryString: false,
    events: {
      endpoint: '/api/observability/analytics',
      trackInitialPage: true,
      sampleRate: 1,
      batchSize: 20,
      flushIntervalMs: 3000,
      maxQueueSize: 500,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
    errors: {
      endpoint: '/api/observability/errors',
      captureResourceErrors: true,
      sampleRate: 1,
      batchSize: 10,
      flushIntervalMs: 3000,
      maxQueueSize: 200,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
    webVitals: { enabled: true },
    exporters: [],
    integrations: { sentry: undefined },
  },
  experiments: {
    'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
  },
};
```

完整字段说明：[site-hooks.md](./site-hooks.md)。Redis、Sentry、A/B 只写在
`ssr.config.ts runtime`，不要写进 `entry.server.ts`。

页面模块可以声明默认 SEO，API 下发值会覆盖：

```tsx
import { getI18n } from '@novel-isr/engine/runtime';

export async function seo({ params }: { params: { id: string } }) {
  const book = await fetchBook(params.id);
  return {
    title: getI18n('seo.book.title', { title: book.title }),
    description: book.summary,
  };
}
```

## 加路由级渲染模式

```ts
// ssr.config.ts
import { defineIsrConfig } from '@novel-isr/engine/config';

export default defineIsrConfig({
  renderMode: 'isr',
  routes: {
    '/':         { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about':    'ssg',
    '/books/*':  { mode: 'isr', ttl: 120, staleWhileRevalidate: undefined },
    '/login':    'ssr',
  },
  ssg: { routes: ['/about'], concurrent: 3 },
});
```

## 三种使用层级

| 层级 | 写什么 | 适合 |
|---|---|---|
| **L0 · 零配置** | 不写任何 entry 文件 | 99% 业务 |
| **L1 · SiteHooks** | `defineSiteHooks({ ... })` | 接 i18n / SEO / auth hooks |
| **L2 · 完全接管** | `export default { fetch: async (req) => Response }` | 极少；想完全替换协议时 |

Engine 按 default export 形状自动分派：含 `.fetch` → 用作 fetch handler；否则视为 hooks。

## 下一步

- 看 bench fixture 怎么用（最小完整 ISR app）：[bench/fixture/](../bench/fixture/)
- 上生产前的 checklist：[deployment.md](./deployment.md)
- 出错了：[troubleshooting.md](./troubleshooting.md)
