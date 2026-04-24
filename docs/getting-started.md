# Getting Started

从零搭一个 `@novel-isr/engine` 站，10 分钟。

## 1. 装依赖

```bash
mkdir my-app && cd my-app
pnpm init
pnpm add @novel-isr/engine react react-dom
pnpm add -D vite typescript @types/react @types/react-dom @types/node
```

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

## 4. `src/app.tsx` —— 唯一必需文件

```tsx
export function App({ url }: { url: URL }) {
  const path = url.pathname;
  return (
    <html lang="en">
      <head><title>My App</title></head>
      <body>
        {path === '/' ? <Home /> : <NotFound />}
      </body>
    </html>
  );
}

function Home() { return <h1>Welcome</h1>; }
function NotFound() { return <h1>404</h1>; }
```

**契约**：`src/app.tsx` 必须 `export function App({ url }: { url: URL })`，返回完整的 `<html>` 树。其余约定优于配置——不写任何 entry 文件就能跑。

## 5. 跑

```bash
pnpm dev                          # → http://localhost:3000
pnpm build && pnpm start          # 生产模式
```

完事。**无需写 entry.tsx / entry.server.tsx / 任何模板代码**，自动获得：
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

## 加 SiteHooks（i18n / SEO / Sentry / 限流）

99% 业务**不需要**写 entry 文件。需要扩展时按声明式配置写：

```tsx
// src/entry.server.tsx
import { defineSiteHooks } from '@novel-isr/engine';

export default defineSiteHooks({
  api: process.env.API_URL!,
  site: process.env.SEO_BASE_URL!,

  intl: {
    locales: ['zh', 'en'] as const,
    defaultLocale: 'zh',
    endpoint: '/api/i18n?locale={locale}',
    ttl: 60_000,
  },

  seo: {
    '/': { title: 'Home', description: '...', ogType: 'website' },
    '/books/:id': {
      endpoint: '/api/books/{id}',
      transform: (raw, { id }) => ({
        title: raw.data.title,
        image: raw.data.cover,
        ogType: 'article',
      }),
    },
  },

  redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL } : undefined,
  sentry: process.env.SENTRY_DSN ? { dsn: process.env.SENTRY_DSN } : undefined,
  rateLimit: { windowMs: 60_000, max: 200 },
});
```

完整字段说明：[site-hooks.md](./site-hooks.md)。

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

- 看演示站怎么用：[novel-rating-website/](../../novel-rating-website/)
- 上生产前的 checklist：[deployment.md](./deployment.md)
- 出错了：[troubleshooting.md](./troubleshooting.md)
