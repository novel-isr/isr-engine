# SiteHooks Configuration

`defineSiteHooks` 是单一的声明式配置入口，覆盖 i18n / SEO / Sentry / Redis / 限流 / A/B / 错误回调。

写法：

```tsx
// src/entry.server.tsx
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  api: process.env.API_URL!,
  site: process.env.SEO_BASE_URL!,
  intl: { /* ... */ },
  seo: { /* ... */ },
  redis: { /* ... */ },
  sentry: { /* ... */ },
  rateLimit: { /* ... */ },
  experiments: { /* ... */ },
});
```

## 字段速查

### `api`, `site`

```ts
api: process.env.API_URL ?? 'http://localhost:3001',
site: process.env.SEO_BASE_URL ?? 'http://localhost:3000',
```

- `api` —— 远程 endpoint 的前缀（`intl.endpoint` / `seo.*.endpoint` 都会拼这个）。同时自动加入 CSP `connect-src` 让浏览器 csr-fallback 能 fetch。
- `site` —— 用于 SEO `canonical` / `og:image` 默认绝对路径前缀（社交爬虫不解析相对路径）。

### `intl`

```ts
intl: {
  // URL 路由层
  locales: ['zh', 'en'] as const,
  defaultLocale: 'zh',
  prefixDefault: false,        // false: '/about'  +  '/en/about'
                               // true:  '/zh/about' + '/en/about'

  // 翻译消息加载层
  endpoint: '/api/i18n?locale={locale}',   // 远程 fetch
  // 或 load: async locale => (await import(`./locales/${locale}.json`)).default,
  ttl: 60_000,
  // detect: req => 'zh',     // 自定义 locale 协商；默认 cookie → Accept-Language → defaultLocale
}
```

URL 路由部分被 `parseLocale` 消费；翻译消息层被 server render、page SEO、客户端导航和 `getI18n()` 消费。远程字典响应可以是嵌套对象，也可以是 dotted keys（engine 会展开）。详细：[i18n.md](./i18n.md)。

### `seo`

路由 pattern → 静态 meta 或 `{ endpoint, transform }` 或 `{ load }`。商业项目通常让页面模块声明默认 SEO，再由 admin/API 通过 `/*` 下发覆盖值。

```ts
seo: {
  // 静态 meta —— 适合纯静态页
  '/': {
    title: 'Home',
    description: '...',
    ogType: 'website',
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite' },
  },

  // 远程 endpoint —— 数据来自上游 API
  '/books/:id': {
    endpoint: '/api/books/{id}',          // {id} 来自路由捕获
    ttl: 300_000,
    transform: (raw, { id }) => ({
      title: `${raw.data.title} · 书评`,
      image: raw.data.cover,              // 相对路径，engine 自动加 site URL
      ogType: 'article',
      alternates: [
        { hreflang: 'zh-CN', href: `/books/${id}` },
        { hreflang: 'en', href: `/en/books/${id}` },
      ],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Book',
        name: raw.data.title,
      },
    }),
  },

  // 本地 load 函数 —— 读 fs / dynamic import / 内存对象
  '/dev/observability': {
    load: () => ({
      title: 'Dev · Observability',
      description: '...',
      noindex: true,
    }),
  },
},
```

Engine 在 `loadSeoMeta` hook 自动按 pattern 匹配，并与页面模块导出的 `seo` / `generateSeo` 合并后注入到 SSR HTML 的 `</head>` 之前。用户**不需要**在组件里写 `<title>` / `<meta>`。

页面级 SEO：

```tsx
// src/pages/BookDetailPage.tsx
import { getI18n } from '@novel-isr/engine/runtime';

export async function seo({ params }: { params: { id: string } }) {
  const book = await fetchBook(params.id);
  return {
    title: getI18n('seo.book.title', { title: book.title }),
    description: book.summary,
    image: book.cover,
  };
}
```

admin 统一下发：

```ts
import type { PageSeoMeta } from '@novel-isr/engine';
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  api: process.env.ADMIN_API_URL,
  site: process.env.SEO_BASE_URL,
  seo: {
    '/*': {
      endpoint: '/api/seo?path={pathname}',
      ttl: 60_000,
      transform: raw => (raw as { data?: PageSeoMeta | null }).data ?? null,
    },
  },
});
```

合并顺序：`page seo` 是页面默认值，`SiteHooks seo` 是上游覆盖值；这样业务页面可以随代码发布基础 SEO，运营/admin 可以热更新标题、描述、OG 图、JSON-LD。

### `redis`

```ts
redis: process.env.REDIS_URL
  ? { url: process.env.REDIS_URL, keyPrefix: 'my-app:' }
  : undefined,
```

- 设了 → 自动启用 L1+L2 双层缓存（详见 [caching.md](./caching.md)）
- 不设 → 看 `REDIS_URL` / `REDIS_HOST` 环境变量
- 都没 → 单层 memory backend

### `sentry`

```ts
sentry: process.env.SENTRY_DSN
  ? {
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV,
    }
  : undefined,
```

设了 → engine 自动 init Sentry + 把 `onError` 接到 `Sentry.captureException`。
要更细粒度（自定义 span / scope）请用 `@novel-isr/engine/adapters/observability` 的 `createSentryServerHooks`，详见 [observability.md](./observability.md)。

### `rateLimit`

```ts
rateLimit: { windowMs: 60_000, max: 200 },
```

Per-IP token bucket。`/health` 与 `/__isr/*` 自动免限流。

### `experiments`

```ts
experiments: {
  'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
},
```

Cookie-sticky A/B 变体。Server Component 用：

```tsx
import { getVariant } from '@novel-isr/engine';
const variant = getVariant('hero-style');   // 'classic' | 'bold'
```

### `onError`

```ts
onError: (err, req, ctx) => {
  // ctx 含 traceId, locale
  console.error('[onError]', { traceId: ctx.traceId, url: req.url });
}
```

默认行为：`console.error` 或 `Sentry.captureException`（如果配了 sentry）。自定义会覆盖。**不要 return Response**——兜底由 engine 处理。

### `beforeRequest`

```ts
beforeRequest: async (req) => {
  return {
    user: parseJwt(req.headers.get('authorization')),
  };
}
```

返回的扩展字段会与 engine 的 baseline ctx (含 `traceId` / `startedAt` / `locale`) 合并。

## 暴露给 app.tsx

`defineSiteHooks` 返回的对象在 server 上下文里也是普通 object——`app.tsx` 可以直接 import 它读 `intl` 字段：

```tsx
// app.tsx
import { resolveI18nConfig } from '@novel-isr/engine/runtime';
import siteHooks from './entry.server';

const I18N = resolveI18nConfig(siteHooks.intl);
// 把 I18N 喂给 parseLocale / withLocale
```

这样 i18n 配置只声明一次，URL 路由层和翻译消息层共享同一份。

## 想完全跳过 SiteHooks？

可以——99% 业务用 SiteHooks 就够了。L0（零配置）和 L2（手写 fetch handler）也支持，详见 [getting-started.md#三种使用层级](./getting-started.md#三种使用层级)。
