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

## 5. `src/entry.server.ts` —— SiteHooks

```ts
import type { PageSeoMeta } from '@novel-isr/engine';
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  api: process.env.ADMIN_API_URL ?? process.env.API_URL!,
  site: process.env.SEO_BASE_URL!,
  intl: {
    locales: ['zh-CN', 'en'] as const,
    defaultLocale: 'zh-CN',
    endpoint: '/api/i18n/{locale}/manifest',
    ttl: 60_000,
  },
  seo: {
    '/*': {
      endpoint: '/api/seo?path={pathname}',
      ttl: 60_000,
      transform: raw => (raw as { data?: PageSeoMeta | null }).data ?? null,
    },
  },
});
```

`api` 指向 admin/API 服务。i18n 字典和 SEO 都可以远程下发，engine 会做 TTL / SWR / 并发去重缓存。

## 6. `src/app.tsx` —— App shell

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

## 7. 跑

```bash
pnpm dev                          # → http://localhost:3000
pnpm build && pnpm start          # 生产模式
```

完事。**无需写 entry.tsx / entry.ssr.tsx / 任何协议模板代码**，自动获得：
- 3 种渲染模式（ISR / SSR / SSG）+ csr-shell server 崩溃兜底
- LRU 缓存 + SWR + 标签级失效
- SEO `/sitemap.xml` / `/robots.txt`
- 自动注入 `x-trace-id` + `x-render-ms` 响应头
- React 19 RSC 完整流水线

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
// src/components/HomeContent.tsx —— Client Component
'use client';
import { useState } from 'react';
import { publishBook } from '../actions/books';

export default function HomeContent() {
  const [name, setName] = useState('');
  return <form action={publishBook}>...</form>;
}
```

详细模式语义：[render-modes.md](./render-modes.md)。
缓存与失效：[caching.md](./caching.md)。

## 扩展 SiteHooks（Redis / Sentry / 限流）

在上面的 `entry.server.ts` 里继续加横切能力：

```tsx
// src/entry.server.tsx
import type { PageSeoMeta } from '@novel-isr/engine';
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  api: process.env.ADMIN_API_URL ?? process.env.API_URL!,
  site: process.env.SEO_BASE_URL!,

  intl: {
    locales: ['zh-CN', 'en'] as const,
    defaultLocale: 'zh-CN',
    endpoint: '/api/i18n/{locale}/manifest',
    ttl: 60_000,
  },

  seo: {
    '/*': {
      endpoint: '/api/seo?path={pathname}',
      ttl: 60_000,
      transform: raw => (raw as { data?: PageSeoMeta | null }).data ?? null,
    },
  },

  redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL } : undefined,
  sentry: process.env.SENTRY_DSN ? { dsn: process.env.SENTRY_DSN } : undefined,
  rateLimit: { windowMs: 60_000, max: 200 },
});
```

完整字段说明：[site-hooks.md](./site-hooks.md)。

页面模块可以声明默认 SEO，admin/API 下发值会覆盖：

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
import type { ISRConfig } from '@novel-isr/engine';

export default {
  mode: 'isr',
  routes: {
    '/':         { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about':    'ssg',
    '/books/*':  { mode: 'isr', ttl: 120 },
    '/login':    'ssr',
  },
  ssg: { routes: ['/about'], concurrent: 3 },
} satisfies ISRConfig;
```

## 三种使用层级

| 层级 | 写什么 | 适合 |
|---|---|---|
| **L0 · 零配置** | 不写任何 entry 文件 | 99% 业务 |
| **L1 · SiteHooks** | `defineSiteHooks({ ... })` | 接 Sentry / i18n / SEO / auth |
| **L2 · 完全接管** | `export default { fetch: async (req) => Response }` | 极少；想完全替换协议时 |

Engine 按 default export 形状自动分派：含 `.fetch` → 用作 fetch handler；否则视为 hooks。

## 下一步

- 看 bench fixture 怎么用（最小完整 ISR app）：[bench/fixture/](../bench/fixture/)
- 上生产前的 checklist：[deployment.md](./deployment.md)
- 出错了：[troubleshooting.md](./troubleshooting.md)
