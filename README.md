# isr-engine

基于 Vite 与 React Server Components 的页面渲染编排层，提供按路由配置的 ISR、SSG、SSR、缓存失效和渲染失败恢复。Flight 编译与传输由 `@vitejs/plugin-rsc` 处理。

## 运行要求与安装

- Node.js **24.15.0**；仓库使用 pnpm 9.15.9。
- TypeScript **6.0.3**；`paths` 相对声明它的配置文件解析，不再设置 `baseUrl`。
- Vite **8.3.8**；引擎内置 `@vitejs/plugin-rsc` **0.5.39** 及其 Flight 运行时。
- React 与 React DOM 使用正式版 **19.3.1**。引擎管理 HTML 流传输依赖。

在应用目录安装引擎和应用直接使用的 React、Vite：

```bash
npm install --save-exact isr-engine react@19.3.1 react-dom@19.3.1
npm install --save-dev --save-exact vite@8.3.8 typescript@6.0.3 \
  @types/node@24.19.2 @types/react@19.3.0 @types/react-dom@19.3.0
```

应用 `package.json` 设置 `"type": "module"`，并保留锁文件以复现依赖组合。

## 最小应用

`vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import { createIsrPlugin } from 'isr-engine';

export default defineConfig({ plugins: [...createIsrPlugin()] });
```

`src/app.tsx` 是应用根 Server Component，必须命名导出 `App`。交互组件单独使用 `'use client'`：

```tsx
import { cacheTag } from 'isr-engine/rsc';

export function App({ url }: { url: URL }) {
  cacheTag('site-content');
  return (
    <html lang="zh-CN">
      <head><meta charSet="utf-8" /><title>My site</title></head>
      <body><main><h1>{url.pathname}</h1></main></body>
    </html>
  );
}
```

项目根目录的 `ssr.config.ts` 声明渲染策略与部署配置：

```ts
import { defineIsrConfig } from 'isr-engine/config';

export default defineIsrConfig({
  renderMode: 'isr',
  revalidate: 60,
  routes: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': 'ssg',
    '/account/*': 'ssr',
  },
  runtime: {
    site: process.env.SITE_URL ?? 'http://localhost:3000',
    services: { api: undefined, telemetry: undefined },
    redis: process.env.REDIS_URL ? {
      url: process.env.REDIS_URL,
      host: undefined, port: undefined, password: undefined,
      keyPrefix: 'my-site:', invalidationChannel: 'my-site:invalidate',
    } : undefined,
    experiments: {},
    i18n: undefined, seo: undefined, telemetry: false,
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
      inventory: { enabled: true, public: false },
    },
  },
  ssg: {
    routes: ['/about'], concurrent: 3,
    requestTimeoutMs: 30_000, maxRetries: 3,
    retryBaseDelayMs: 200, failBuildThreshold: 0.05,
  },
});
```

`package.json` 脚本：

```json
{
  "scripts": {
    "dev": "isr-engine dev",
    "build": "vite build",
    "start": "isr-engine start"
  }
}
```

```bash
npm run dev                          # 默认 http://localhost:3000
npm run build                        # 构建 RSC/SSR/client，并预渲染 SSG 路由
NODE_ENV=production npm run start    # 从应用根目录启动生产服务
```

`dev`、`start` 接受 `--port <port>` 和 `--host <host>`，显式参数覆盖配置。`dev --no-open` 关闭自动打开浏览器。构建和启动生产进程时通过运行环境设置 `NODE_ENV`，避免 `.env*` 中的 `NODE_ENV=development` 影响生产构建。

## 渲染与生产缓存

| 模式 | 行为 |
| --- | --- |
| `isr` | 按 TTL 缓存；SWR 窗口内返回旧响应并后台重渲，窗口结束后重新生成。 |
| `ssg` | 构建时预生成配置的路由；运行时仍受缓存新鲜度与失效策略管理。 |
| `ssr` | 每次请求渲染，跳过共享页面缓存。 |

TTL 与 SWR 单位为秒。`routes` 控制渲染策略；页面路由可使用 `isr-engine/runtime` 的 `defineRoutes` 统一声明。渲染异常的 `csr-shell` 是自动恢复策略；origin 进程不可用时的切换需在反向代理/CDN 配置。

- 未配置 `runtime.redis.url/host` 时使用进程内存缓存，重启即清空，各实例独立。
- 显式配置 Redis 后启用远端版本校验和跨实例失效广播，需保留可选依赖 `ioredis`；Redis 连接只读取配置，须如示例显式接入环境变量。多实例共享相同应用的前缀与频道，不同应用/环境使用独立命名空间。
- 登录态、权限相关或个性化页面应配置为 `ssr`，并在业务层验证身份。请求 hooks 与缓存标签不提供访问控制，也不会自动按用户隔离页面。
- 授权头、普通业务 Cookie，以及 `private`/`no-store` 等响应会触发缓存保护；不要依赖这些保护代替路由策略。`anon` 与实验 Cookie 有专门的共享缓存规则。
- Server Component 使用 `cacheTag('site-content')` 声明依赖；数据更新成功后，在受业务鉴权保护的服务端代码中 `await revalidateTag('site-content')` 或 `await revalidatePath('/about')`，从 `isr-engine/rsc` 导入。

后台提交发布、撤稿或索引状态更新后，从 `isr-engine/rsc` 调用 `await revalidateContent({ paths: ['/about'], locales: ['en'], sitemap: true })`。按实际变化指定页面路径或标签、字典语言和 sitemap，引擎先失效相关元数据，再失效对应 ISR 响应。其他实例的进程内元数据通过 Redis 广播刷新，断连时可在重连回放或缓存到期后更新。

`runtime.seo.sitemap.load({ services })` 从已提交的数据批量读取完整目录。每条包含站内绝对路径 `path`、`status`，可带 `noindex` 和真实内容更新时间 `modifiedTime`。引擎只输出已发布且可索引的条目，缺少更新时间时省略 `lastmod`。单份 sitemap 上限为 50,000 个 URL 和 50 MiB。

请求期扩展可放在可选的 `src/entry.server.tsx`，默认导出 `defineAdminSiteHooks({ beforeRequest, onError })`（从 `isr-engine/site-hooks` 导入）。部署配置留在 `ssr.config.ts`；Server Component 用 `getRequestContext()` 读取 hooks 注入的上下文。

`Logger.spin()` 返回 Ora 10 对象。`prefixText`、`suffixText` 可为字符串或生成函数；`color` 接受颜色名、`false` 或 `undefined`；自定义 spinner 的 `interval` 必须是正安全整数。

`Logger.getInstance({ logFile })` 的文件输出为 JSON Lines，每行独立保存时间、级别、请求上下文、参数与错误；采集程序应按 JSON 解析，原有纯文本文件可在升级前轮转。

## 运维与部署

部署保留完整 `dist/`、应用依赖及 `ssr.config.*`；配置编译需要应用根目录可写的 `.isr-cache/`。容器按需设置 `HOST=0.0.0.0`，反向代理后显式配置 `server.trustProxy` 的可信来源。

`/health` 默认公开。生产 `/metrics` 默认关闭；非公开 metrics/inventory 未配置 `server.ops.authToken` 会自动关闭。启用后通过 `Authorization: Bearer <token>` 或配置的 token header 访问；设为 `public: true` 会绕过 token 校验。

引擎运维接口、静态 HTML 文件读取和 SEO 路由分别使用进程内请求预算；超额返回 `429` 与 `Retry-After`。通过 `server.requestLimits.{ops,staticHtml,seo}` 配置 `windowMs`、单客户端 `maxRequests`、总量 `globalMaxRequests` 与容量 `maxClients`，均须为正整数。默认每分钟单客户端/总量分别为 `120/1200`、`600/12000`、`120/1200`；缓存 HIT 与应用 SSR/API 不计入这些预算。

Google 字体自托管只接受指定 Google HTTPS 来源，验证下载内容后交给 Vite 输出；`outDir` 相对构建输出目录，开发环境从内存提供资源。下载失败会使该优化任务失败，构建不再改写应用 `public/`。

```bash
curl -fsS http://localhost:3000/health
curl -fsS -H "x-isr-admin-token: $ISR_OPS_TOKEN" \
  http://localhost:3000/__isr/cache/inventory
```

排查页面时先看 `X-Cache-Status`、`X-Resolved-Mode`、`X-Render-Strategy`。本地代理验证可用 `isr-engine test-fallback-local --help`；生产切换由部署层完成，浏览器恢复仍依赖可用的资源与数据服务。

## 公共入口

| 导入路径 | 用途 |
| --- | --- |
| `isr-engine` | Vite 插件、Node 编排 API 与公共类型。 |
| `isr-engine/config` | `ssr.config.ts` 使用的 `defineIsrConfig`、`defineRuntimeConfig`、`withLocale`、`alternates`。 |
| `isr-engine/rsc` | 缓存标签、失效、服务端请求上下文。 |
| `isr-engine/runtime` | 页面路由、边界、i18n 与浏览器 telemetry。 |
| `isr-engine/site-hooks` | 请求 hooks 工厂与 Cookie 工具。 |
| `isr-engine/server-entry`、`isr-engine/client-entry` | 高级入口工厂；由 Vite 转译其源码。 |
| `isr-engine/image` | 图片组件。 |
| `isr-engine/auto-observability`、`isr-engine/adapters/observability` | 自动观测与观测适配器。 |
| `isr-engine/adapters/runtime` | Fetch handler 的平台适配器。 |
| `isr-engine/package.json` | 包元数据。 |

## 文档与发布

语言切换可从 `isr-engine/runtime` 使用 `<LocaleLink locale="ja" config={i18n}>日本語</LocaleLink>`。
组件在引擎接管后可操作，沿用当前路径、查询参数和锚点。
使用 `runtime.i18n.prefixDefault: true` 的站点可选设 `rememberLocale: true`。`LocaleLink` 保存主动切换的语言，下次访问裸根路径时优先采用，带语言前缀的 URL 始终优先。语言协商跳转默认发送 `Cache-Control: no-store`。

配置字段与默认行为见 [公共配置类型](./src/types/ISRConfig.ts) 和 [默认配置](./src/config/defaults.ts)。

`main` 的自动发布流程通过验证后由 semantic-release 计算版本，以 npm OIDC 发布到 `registry.npmjs.org`；配置见 [发布工作流](./.github/workflows/publish.yml) 与 [release.config.mjs](./release.config.mjs)。npm 端需绑定对应仓库和工作流的 Trusted Publisher。

发布必须通过依赖审计和 CodeQL `security-extended` 扫描；任何扫描结果或缺失的扫描证据都会阻止发布，原始审计与 SARIF 结果保留为工作流产物。

许可证声明为 **UNLICENSED**，以 `package.json` 为准。
