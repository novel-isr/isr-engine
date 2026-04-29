# SiteHooks Configuration

成熟项目建议把配置分成两层：

- `ssr.config.ts`：启动期 / 部署期 / 平台级配置，例如 `runtime.site`、`runtime.services`、Redis、Sentry、限流、A/B 实验、路由渲染模式。
- `src/entry.server.tsx`：请求期 hooks，例如 locale 协商、i18n 字典加载、SEO 远程加载、`beforeRequest`、`onResponse`、`onError`。

第一性原则是：会影响整个运行时拓扑的东西放配置文件；会依赖本次请求的东西放 server entry。

## 推荐结构

```ts
// ssr.config.ts
import type { ISRConfig } from '@novel-isr/engine';

export const runtime = {
  site: process.env.SEO_BASE_URL ?? 'http://localhost:3000',
  services: {
    api: process.env.API_URL ?? 'http://localhost:8080',
    i18n: process.env.I18N_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
    seo: process.env.SEO_API_URL ?? process.env.API_URL ?? 'http://localhost:8080',
  },
  redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL, keyPrefix: 'isr:' } : undefined,
  sentry: process.env.SENTRY_DSN ? { dsn: process.env.SENTRY_DSN } : undefined,
  rateLimit: { windowMs: 60_000, max: 200 },
  experiments: {
    'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
  },
} satisfies NonNullable<ISRConfig['runtime']>;

export default {
  renderMode: 'isr',
  runtime,
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': 'ssg',
    '/login': 'ssr',
    '/*': 'isr',
  },
  ssg: { routes: ['/about'] },
  isr: { revalidate: 3600 },
  cache: { strategy: 'memory', ttl: 3600 },
} satisfies ISRConfig;
```

```tsx
// src/entry.server.tsx
import { defineAdminSiteHooks } from '@novel-isr/engine/site-hooks';
import baseline from './config/site-baseline.json';

export default defineAdminSiteHooks({
  baseline,
  intl: { ttl: 60_000 },
  seo: { ttl: 60_000 },
});
```

`defineSiteHooks` 不接收 Redis、Sentry、限流或 A/B 实验配置。这些能力只从
`ssr.config.ts runtime` 读取。`runtime.site/services` 也由 engine 注入到默认 server
entry，业务不需要在 `entry.server.tsx` 里 import `ssr.config.ts`。

## `runtime`

`runtime` 是平台配置入口：

- `site`：站点公网 base URL。用于 canonical、OG image、sitemap、robots；它是用户访问域名，不是后端 API 地址。
- `services.api`：默认后端 API base URL，例如书籍、用户、评分、admin 配置和 mock fixture。i18n / SEO 未拆服务时都回退到它。
- `services.i18n`：i18n 字典下发 base URL。只有字典服务独立部署时才需要配置。
- `services.seo`：SEO 配置下发 base URL。只有 SEO 配置服务独立部署时才需要配置。
- `redis`：分布式 ISR 缓存和跨实例失效广播。没有 Redis 时自动使用进程内 memory cache。
- `sentry`：服务端错误监控。
- `rateLimit`：站点级限流。
- `experiments`：A/B 实验定义，Server Component 用 `getVariant()` 读取。

## `intl`

```ts
intl: {
  locales: ['zh-CN', 'en'] as const,
  defaultLocale: 'zh-CN',
  prefixDefault: false,
  load: createAdminIntlLoader({
    endpoint: '/api/i18n/{locale}/manifest',
    fallbackMessages: baseline.i18n.strings,
    defaultLocale: baseline.site.defaultLocale,
    // baseUrl: 'https://i18n.example.com', // 可选；默认使用 runtime.services.i18n/api
  }),
  ttl: 60_000,
}
```

远程字典响应可以是嵌套对象，也可以是 dotted keys，engine 会展开并注入到 SSR/RSC payload。页面里直接用：

```tsx
import { getI18n } from '@novel-isr/engine/runtime';

export default function Page() {
  return <h1>{getI18n('home.hero.title')}</h1>;
}
```

带变量：

```tsx
getI18n('book.reviewCount', { count: 12 });
```

字典里的占位符用 `{count}` 形式，例如：`"{count} 条评价"`。SSR 时字典已经在 server context 中；CSR recovery 时字典会随 RSC payload 或本地 fallback 一起可用，不需要页面自己重新设计 provider。

如果 `load` / `transform` 返回 `source`，engine 会写 `X-I18n-Source`，dev inspector 也会显示，例如 `admin` 或 `local-fallback`。

## `seo`

SEO 推荐两层：

- 页面模块导出 `seo` / `generateSeo`，声明跟页面数据绑定的默认 SEO。
- admin/API 通过 `entry.server.tsx` 的 `seo: { '/*': ... }` 下发运营覆盖值。

```tsx
// src/pages/BookDetailPage.tsx
import { getI18n } from '@novel-isr/engine/runtime';

export async function seo({ params }: { params: { id: string } }) {
  const book = await fetchBook(params.id);
  return {
    title: getI18n('seo.book.title', { title: book.title }),
    description: book.summary,
    image: book.cover,
    ogType: 'article',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Book',
      name: book.title,
    },
  };
}
```

```ts
// src/entry.server.tsx
import { createAdminSeoLoader } from '@novel-isr/engine/site-hooks';

seo: {
  '/*': {
    load: createAdminSeoLoader({
      endpoint: '/api/seo?path={pathname}',
      fallbackEntries: baseline.seo.entries,
      // baseUrl: 'https://seo.example.com', // 可选；默认使用 runtime.services.seo/api
    }),
    ttl: 60_000,
  },
}
```

合并顺序：页面 SEO 是代码默认值，SiteHooks SEO 是上游覆盖值。用户不需要在组件里写 `<title>` / `<meta>`。

## `beforeRequest` / `onResponse` / `onError`

```ts
beforeRequest: async req => ({
  user: parseJwt(req.headers.get('authorization')),
}),
onResponse: async (res, ctx) => {
  res.headers.set('x-trace-id', ctx.traceId);
},
onError: async (err, req, ctx) => {
  console.error('[render error]', { traceId: ctx.traceId, url: req.url, err });
},
```

`beforeRequest` 返回值会和 engine baseline context 合并。`onError` 不要返回 `Response`，兜底策略由 engine 统一处理。

## Client Entry

开发态浮层属于浏览器 client runtime，关闭时写在 `src/entry.tsx`：

```ts
export default {
  devInspector: false,
};
```

不要写到 `src/entry.server.tsx`。详见 [dev-inspector.md](./dev-inspector.md)。
