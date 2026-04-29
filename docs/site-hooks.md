# SiteHooks Configuration

成熟项目建议把配置分成两层：

- `ssr.config.ts`：启动期 / 部署期 / 平台级配置，例如 `runtime.site`、`runtime.services`、`runtime.i18n`、`runtime.seo`、Redis、Sentry、限流、A/B 实验、路由渲染模式。
- `src/entry.server.tsx`：请求期 hooks，例如用户、租户、灰度上下文、`beforeRequest`、`onError`。

第一性原则是：会影响整个运行时拓扑的东西放配置文件；会依赖本次请求的东西放 server entry。

## 推荐结构

```ts
// ssr.config.ts
import type { ISRConfig } from '@novel-isr/engine';
import fallbackLocal from './src/config/site-fallback-local.json';

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

`defineSiteHooks` 不接收 Redis、Sentry、限流或 A/B 实验配置。这些能力只从
`ssr.config.ts runtime` 读取。`runtime.site/services/i18n/seo` 也由 engine 注入到默认
server entry，业务不需要在 `entry.server.tsx` 里 import `ssr.config.ts`。

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
- `i18n`：字典 endpoint、TTL、locale 列表和本地 `fallbackLocal`。
- `seo`：页面 SEO endpoint、TTL 和本地 `fallbackLocal`。它和 `ISRConfig.seo.baseUrl` 不同，后者只管 sitemap/robots/canonical base URL。

## `runtime.i18n`

商业项目优先在 `ssr.config.ts runtime.i18n` 配置。engine 会自动生成 `loadIntl`，
服务端首次渲染时拉取字典，并把结果随 RSC payload 复用到客户端。

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

如果远端命中，engine 会写 `X-I18n-Source: remote`；如果使用本地兜底，会写
`X-I18n-Source: local-fallback`，dev inspector 也会显示。

## `seo`

SEO 推荐两层：

- 页面模块导出 `seo` / `generateSeo`，声明跟页面数据绑定的默认 SEO。
- API 通过 `runtime.seo.endpoint` 下发运营覆盖值。

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

合并顺序：页面 SEO 是代码默认值，SiteHooks SEO 是上游覆盖值。用户不需要在组件里写 `<title>` / `<meta>`。

## `beforeRequest` / `onError`

```ts
beforeRequest: async req => ({
  userId: req.headers.get('x-user-id') ?? readCookie(req, 'uid') ?? undefined,
  tenantId: req.headers.get('x-tenant-id') ?? 'public',
}),
onError: async (err, req, ctx) => {
  console.error('[render error]', { traceId: ctx.traceId, url: req.url, err });
},
```

`beforeRequest` 返回值会和 engine 基线 context 合并，并同步进 RequestContext。
Server Component 可用 `getRequestContext()` 读取用户、租户等请求级信息。`onError`
不要返回 `Response`，兜底策略由 engine 统一处理。

`readCookie()` 由 engine 提供，兼容 Web `Request` 和 Node/Express header record。
业务不要自己写正则解析 cookie，避免在 SSR、dev server、middleware 和测试环境之间
出现不一致。

## Client Entry

开发态浮层属于浏览器 client runtime，关闭时写在 `src/entry.tsx`：

```ts
export default {
  devInspector: false,
};
```

不要写到 `src/entry.server.tsx`。详见 [dev-inspector.md](./dev-inspector.md)。
