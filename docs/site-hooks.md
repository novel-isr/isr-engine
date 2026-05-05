# SiteHooks Configuration

成熟项目建议把配置分成两层：

- `ssr.config.ts`：启动期 / 部署期 / 平台级配置，例如 `runtime.site`、`runtime.services`、`runtime.i18n`、`runtime.seo`、Redis、telemetry endpoint、限流、A/B testing、路由渲染模式。
- `src/entry.server.tsx`：请求期 hooks，例如用户、租户、灰度上下文、`beforeRequest`、`onError`。

第一性原则是：会影响整个运行时拓扑的东西放配置文件；会依赖本次请求的东西放 server entry。

## 推荐结构

```ts
// ssr.config.ts
import { defineIsrConfig } from '@novel-isr/engine/config';
import fallbackLocal from './src/config/site-fallback-local.json';

export default defineIsrConfig({
  renderMode: 'isr',
  revalidate: 3600,
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': 'ssg',
    '/login': 'ssr',
    '/*': 'isr',
  },
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
      events: false,
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
      webVitals: false,
      exporters: [],
      integrations: { sentry: undefined },
    },
    rateLimit: {
      store: 'auto',
      windowMs: 60_000,
      max: 200,
      lruMax: 10_000,
      trustProxy: process.env.TRUST_PROXY === '1',
      sendHeaders: true,
      keyPrefix: 'isr:rate-limit:',
      skipPaths: [],
      skipPathPrefixes: [],
      skipExtensions: [],
    },
    experiments: {
      'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
    },
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
  server: {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST,
    strictPort: process.env.NODE_ENV === 'production',
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
});
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

`defineSiteHooks` 不接收 Redis、Sentry、限流或 A/B testing 配置。这些能力只从
`ssr.config.ts runtime` 读取。`runtime.site/services/i18n/seo` 也由 engine 注入到默认
server entry，业务不需要在 `entry.server.tsx` 里 import `ssr.config.ts`。

## `runtime`

`runtime` 是平台配置入口：

- `site`：站点公网 base URL。用于 canonical、OG image、sitemap、robots；它是用户访问域名，不是后端 API 地址。
- `services.api`：默认后端 API base URL，例如书籍、用户、评分、配置中心、i18n、SEO 和 mock fixture。
- `services.telemetry`：telemetry 上报 base URL；不配置时回退到 `services.api`。
- `redis`：分布式 ISR 缓存和跨实例失效广播。只有 `runtime.redis.url/host` 非空时 engine 才启用 Redis；没有 Redis 时自动使用进程内 memory cache。页面 TTL 不在这里配置，而在 `routes[*].ttl` / `revalidate`。
- `telemetry.integrations.sentry`：Sentry 第三方集成；第一方上报仍用 `telemetry.events/errors/webVitals` endpoint。
- `rateLimit`：站点入口限流；默认 `store: 'auto'`，有 Redis 连接就分布式，否则进程内 memory fixed-window counter。
- `experiments`：A/B testing / experimentation 定义，Server Component 用 `getVariant()` 读取。
- `i18n`：字典 endpoint、TTL、locale 列表和本地 `fallbackLocal`。
- `seo`：页面 SEO endpoint、TTL 和本地 `fallbackLocal`。sitemap/robots/canonical base URL 统一来自 `runtime.site`。

## `runtime.rateLimit`

`rateLimit` 是 engine 入口中间件，不需要业务自己挂 Express middleware。

```ts
runtime: {
  redis: {
    url: process.env.REDIS_URL,
    host: undefined,
    port: undefined,
    password: undefined,
    keyPrefix: 'novel:',
    invalidationChannel: 'novel:isr:invalidate',
  },
  rateLimit: {
    store: 'auto',
    windowMs: 60_000,
    max: 200,
    lruMax: 10_000,
    trustProxy: false,
    sendHeaders: true,
    keyPrefix: 'novel:rate-limit:',
    skipPaths: [],
    skipPathPrefixes: [],
    skipExtensions: [],
  },
}
```

- `store`：默认 `auto`；检测到 `runtime.redis.url/host` 才用 Redis，否则进程内 memory。
- `windowMs`：固定窗口长度，单位毫秒。`60_000` 表示 1 分钟。
- `max`：每个 key 在一个窗口内允许的最大请求数；默认 key 是客户端 IP。
- `lruMax`：memory store 最多保留多少个 key。
- `trustProxy`：只在可信 CDN/LB/Nginx 后面开启，用 `CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For` 识别真实客户端 IP。
- `sendHeaders`：是否返回 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`、`Retry-After`。
- `keyPrefix`：Redis store 的 key 前缀；避免和页面缓存或业务 Redis key 冲突。
- `skipPaths` / `skipPathPrefixes` / `skipExtensions`：补充业务自己的跳过规则。engine 默认已经跳过 `/health`、`/metrics`、`OPTIONS`、静态资源扩展名，以及 dev 下的 Vite/module 请求，避免 CSS/JS/HMR 把应用入口配额耗光。

Redis store 使用 Lua 原子完成计数和 TTL 设置；Redis 报错时 engine fail-open 放行请求并记录 warning，避免限流组件故障拖垮站点。强配额、计费 API、登录和支付风控仍应在业务 API 或网关层单独做。

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

`beforeRequest` 是请求期上下文入口。它解决的问题不是“怎么渲染页面”，而是：
**每一次请求进入 SSR / ISR / RSC 渲染前，如何把本次请求才知道的信息放进
RequestContext，让 Server Component 能安全读取。**

一次请求的简化链路：

```txt
HTTP request
  → engine 建立 RequestContext(traceId, startedAt, locale...)
  → entry.server.tsx beforeRequest(req)
  → 合并 beforeRequest 返回值到 RequestContext
  → i18n / SEO loader
  → RSC Server Component 渲染
  → SSR HTML / Flight / cache
```

所以它适合放：

- `userId`：从网关 header、session cookie 或 token 里解析出的用户身份。
- `tenantId`：SaaS / 白标站 / 渠道站，从域名、header、cookie 或路径里解析。
- `requestSegment`：灰度分层、渠道、设备、风控分群、审计标签。
- 轻量观测字段：例如 `requestSource`、`traceParent`。

它不适合放：

- i18n / SEO endpoint、TTL、Redis、Sentry、限流、A/B testing 定义，这些属于 `ssr.config.ts runtime`。
- 数据库查询、慢 API 查询、复杂鉴权。`beforeRequest` 在首屏关键路径上，应保持 O(1) 的 header/cookie 解析。
- 页面业务渲染逻辑。页面逻辑应该在 Server Component 内消费 `getRequestContext()`。
- 自己解析 A/B cookie。A/B variant 由 engine middleware 注入，页面用 `getVariant()` 读取。

```ts
beforeRequest: async req => ({
  userId: req.headers.get('x-user-id') ?? readCookie(req, 'uid') ?? undefined,
  tenantId: req.headers.get('x-tenant-id') ?? 'public',
  requestSegment: req.headers.get('x-segment') ?? 'default',
}),
onError: async (err, req, ctx) => {
  console.error('[render error]', { traceId: ctx.traceId, url: req.url, err });
},
```

`beforeRequest` 返回值会和 engine 基线 context 合并，并同步进 RequestContext。
Server Component 可用 `getRequestContext()` 读取用户、租户等请求级信息。`onError`
不要返回 `Response`，兜底策略由 engine 统一处理。

`onError` 是追加回调，不会关闭平台默认上报：当 `ssr.config.ts`
配置了 `runtime.telemetry.errors` 时，engine 会先把服务端渲染异常
fire-and-forget 上报到 telemetry endpoint，再执行业务自定义 `onError`。业务 `onError`
适合补充结构化日志、审计字段或自建告警，不要再重复做同一份 endpoint 上传。
如果同时配置 `runtime.telemetry.integrations.sentry.enabled=true`，Sentry 会作为同一条
telemetry pipeline 的第三方平台集成执行；integration 失败不会阻断 endpoint 上报或业务 `onError`。
如果不希望第一方 endpoint 和 Sentry 双写，显式关闭 `runtime.telemetry.errors`
即可。

`readCookie()` 由 engine 提供，兼容 Web `Request` 和 Node/Express header record。
业务不要自己写正则解析 cookie，避免在 SSR、dev server、middleware 和测试环境之间
出现不一致。

### 页面里怎么用

只在 Server Component 或 server-side helper 中读取：

```tsx
import { getRequestContext } from '@novel-isr/engine/rsc';
import { fetchData } from './lib/api';

export default async function HomePage() {
  const ctx = getRequestContext();
  const tenantId =
    typeof ctx?.tenantId === 'string' ? ctx.tenantId : 'public';

  const books = await fetchData(
    `/books?tenant=${encodeURIComponent(tenantId)}`
  );

  return <BookGrid books={books ?? []} />;
}
```

如果要给 Client Component 用，Server Component 先读取，再传普通可序列化 props：

```tsx
import { getRequestContext } from '@novel-isr/engine/rsc';
import ClientPanel from './ClientPanel.client';

export default function Page() {
  const ctx = getRequestContext();
  const tenantId =
    typeof ctx?.tenantId === 'string' ? ctx.tenantId : 'public';

  return <ClientPanel tenantId={tenantId} />;
}
```

Client Component 不能直接调用 `getRequestContext()`。它运行在浏览器，拿不到
服务端 AsyncLocalStorage 中的请求上下文。

### 什么时候不应该用

不要为了“用上 context”而读取它。下面这种写法没有业务价值：

```tsx
const ctx = getRequestContext();
const tenantId = typeof ctx?.tenantId === 'string' ? ctx.tenantId : 'public';
cacheTag(`tenant:${tenantId}`);
```

如果页面数据、UI、权限、SEO 或失效策略都不随 `tenantId` 变化，只打一个
`cacheTag` 只会让缓存治理更难理解。成熟做法是：**只有当业务确实按
tenant/user/segment 产生差异时，才读取 RequestContext。**

用户级个性化尤其要谨慎。如果 `userId` 会改变 SSR HTML，不要继续用公共 ISR
缓存；应改为 SSR、用户级缓存隔离，或把登录后个性化放到客户端加载，避免缓存串用户。

### 和 A/B testing 的关系

A/B testing 定义放 `ssr.config.ts runtime.experiments`。字段名 `experiments`
是 experimentation platform 的通用术语，可以表达 A/B 或多变体测试：

```ts
export default {
  runtime: {
    experiments: {
      'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
    },
  },
};
```

engine 会处理：

- 首访按权重分配 variant。
- 写 sticky cookie，例如 `ab=hero-style%3Dclassic`。
- 把 variant 注入 `RequestContext.flags`。
- ISR cache key 按 variant 隔离，避免 A 组拿到 B 组 HTML。

页面用 `getVariant()`：

```tsx
import { getVariant } from '@novel-isr/engine/rsc';

export default function HomePage() {
  const heroVariant = getVariant('hero-style');
  return heroVariant === 'bold' ? <BoldHero /> : <ClassicHero />;
}
```

`beforeRequest` 可以补充 `tenantId` / `requestSegment` 供日志和页面使用，但不要
覆盖 `ctx.flags`，也不要自己解析 `ab` cookie。若要做“某租户只进入某实验”，
应在实验平台或后端分流服务里表达，engine 负责稳定注入结果。

### HomePage 里的真实租户业务应该是什么

以小说评分站为例，`tenantId` 不是装饰字段，它应该对应真实的业务隔离：

- 白标/渠道站：`public`、`fantasy`、`suspense`、`campus` 不同租户看到不同首页书库。
- 内容合规：某些租户只允许展示已审核书籍、特定分级或特定版权来源。
- 运营位：不同租户的首页 hero、榜单排序、推荐集合、SEO canonical 可以不同。
- 缓存失效：`revalidateTag('tenant:fantasy:books')` 只清 fantasy 租户首页，不影响 public。

对应页面逻辑应该真的改变数据或 UI：

```tsx
const ctx = getRequestContext();
const tenantId = typeof ctx?.tenantId === 'string' ? ctx.tenantId : 'public';

cacheTag(`tenant:${tenantId}:home`);
cacheTag(`tenant:${tenantId}:books`);

const books = await fetchData(
  `/books?tenant=${encodeURIComponent(tenantId)}`
);
const curation = await fetchData(
  `/curation/home?tenant=${encodeURIComponent(tenantId)}`
);
```

如果后端还没有 `tenant` 维度，就不要在 HomePage 里提前接 `tenantId`。等
catalog / curation / SEO 或主题配置真正支持租户后再接入，才是可维护的实现。

## Client Entry

开发态浮层属于浏览器 client runtime，关闭时写在 `src/entry.tsx`：

```ts
export default {
  devInspector: false,
};
```

不要写到 `src/entry.server.tsx`。详见 [dev-inspector.md](./dev-inspector.md)。
