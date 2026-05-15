# Deployment

## 构建

```bash
pnpm vite build
```

产物：

```
dist/
├── client/        浏览器资源 + SSG 预生成 HTML
│   ├── about/index.html      ← spider 预生成
│   ├── assets/<hash>.js
│   └── ...
├── rsc/           RSC handler bundle
└── ssr/           SSR HTML 转换 bundle
```

## 启动

```bash
pnpm novel-isr start
```

中间件链（按顺序）：

```
helmet → security headers → gzip/deflate(streaming-safe) → static (SSG 路由)
       → ISR cache → protected ops endpoints → catch-all RSC handler
```

## ⚠️ NODE_ENV 禁忌：绝不写 `.env` 文件

`NODE_ENV` 必须通过 **OS env 层**注入（K8s ConfigMap、Docker `ENV` 指令、shell 前缀），**任何 `.env` / `.env.*` 文件都不能写**。

**为什么：** Vite 8 启动时 `loadEnv()` 把 `.env` 里的 `NODE_ENV` 锁进 `VITE_USER_NODE_ENV`，让 `vite build` 即使是 production 模式也回退到 development，esbuild 用 `jsxDev: true`，但 React 19 生产 `react-server` runtime 的 `jsxDEV` 是 `void 0` → SSG 渲染时 `TypeError: jsxDEV is not a function` → 全部预渲染路由失败。

**正确姿势：**

| 场景 | NODE_ENV 设法 |
|------|--------------|
| `pnpm dev` | Vite 启动自动 `'development'` |
| `pnpm build` | Vite 启动自动 `'production'` |
| `pnpm test` | Vitest 启动自动 `'test'` |
| `pnpm start` | `package.json` script 前缀 `"start": "NODE_ENV=production novel-isr start"` |
| Docker `docker run` | Dockerfile `ENV NODE_ENV=production` |
| K8s prod | ConfigMap `NODE_ENV: production`（OS env 层，在任何 npm import 之前生效）|

## 生产环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `PORT` | 监听端口（默认 3000） | `PORT=8080` |
| `NODE_ENV` | 必须 `production`；通过容器 env 注入（K8s ConfigMap / Docker `ENV` / `pnpm start` 前缀），**不要写 `.env` 文件**（见下方禁忌）| K8s ConfigMap |
| `SITE_URL` | 站点公网域名；在 `ssr.config.ts runtime.site` 显式读取 | `https://my-app.com` |
| `API_URL` | 上游 API 基址 | `https://api.internal/v1` |
| `REDIS_URL` | Redis L2 缓存；在 `ssr.config.ts runtime.redis.url` 显式读取 | `redis://...:6379/0` |
| `SENTRY_ENABLED` | 是否启用 Sentry integration | `true` |
| `SENTRY_DSN` | Sentry DSN；仅在启用 integration 后使用 | `https://...@sentry.io/...` |
| `ISR_OPS_TOKEN` | `/metrics` 鉴权（如果生产开启） | 任意 secret |

## Node origin 配置

业务只配置 Node origin 的监听边界和 ops 认证；TLS、HTTP/2/3、Brotli、网关超时属于 CDN / Ingress / Nginx / Envoy / ALB。

```ts
// ssr.config.ts
export default defineIsrConfig({
  renderMode: 'isr',
  revalidate: 3600,
  routes: {},
  runtime: {
    site: process.env.SITE_URL,
    services: {
      api: process.env.API_URL,
      telemetry: process.env.TELEMETRY_API_URL ?? process.env.API_URL,
    },
    redis: {
      url: process.env.REDIS_URL,
      host: undefined,
      port: undefined,
      password: undefined,
      keyPrefix: 'isr:',
      invalidationChannel: 'isr:invalidate',
    },
    experiments: {},
    i18n: undefined,
    seo: undefined,
    telemetry: false,
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
    routes: [],
    concurrent: 3,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },
});
```

`strictPort=true` 时端口占用会直接失败，适合生产和 CI；`false` 仅用于本地 dev 自动尝试后续端口。

## Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm vite build
EXPOSE 3000
CMD ["pnpm", "novel-isr", "start"]
```

## 端点权限默认值

| 端点 | dev | prod |
|---|---|---|
| `/health` | 公开 | 公开 |
| `/sitemap.xml` `/robots.txt` | 公开 | 公开 |
| `/metrics` | 开 | 默认不注册；需要 `server.ops.metrics.enabled` + token |

## Edge runtime 部署

`defineServerEntry` 返回的 `{ fetch }` 就是 Web Fetch 标准 server handler。各平台一行 wrapper：

### Cloudflare Workers

```ts
// worker.ts
import handler from './src/entry.server';
import { toCloudflareWorker } from '@novel-isr/engine/adapters/runtime';
export default toCloudflareWorker(handler);
```

### Vercel Edge Functions

```ts
// api/[[...slug]].ts
import handler from '../src/entry.server';
import { toVercelEdge } from '@novel-isr/engine/adapters/runtime';
export const config = { runtime: 'edge' };
export default toVercelEdge(handler);
```

### Edge 限制

务必读完再决定是否上：

| 限制 | 影响 | 解决 |
|---|---|---|
| 不能用 helmet / compression | 这俩是 Node 中间件 | CF/Vercel 自带边缘安全 + 自动 br/gzip |
| 不能用 sharp | C++ 原生绑定 | Cloudflare Images / `@cf/wasm/sharp` / `@vercel/og` |
| L1 LRU 不跨 isolate / region | 缓存命中率下降 | Cloudflare KV / R2 / D1 作 L2（用户自接 `RedisCacheAdapter` 同套接口） |
| 字体下载（构建时）需 Node | `createFontPlugin` 的 google 选项 | 构建在 Node CI 里跑，运行时只读静态资源，无影响 |
| 文件系统 read | 图片端点的 publicDir 读取 | Edge 用 `fetch()` 同站资源代替 |

## Middleware（i18n / A/B）

i18n / A/B 是平台级横切能力，生产配置写在 `ssr.config.ts runtime`：

- `runtime.i18n`：locale、远端字典 endpoint、TTL、本地 fallback。
- `runtime.experiments`：A/B testing / experimentation 定义；页面用 `getVariant()`。

**Rate limiting 不在 engine 范畴**：业界标准（Next.js / Remix / Astro 同款）走
CDN/WAF/Gateway（Cloudflare WAF / AWS WAF / Vercel Edge / Kong / Envoy）。

`entry.server.tsx beforeRequest` 只补充本次请求的业务上下文字段，例如
`userId`。不要在 `beforeRequest` 里重新实现 i18n、A/B。详见 [site-hooks.md](./site-hooks.md)。

Vercel Edge 部署可用 `toVercelMiddleware` 包出平台原生 `middleware.ts`，详见
`src/adapters/runtime/vercel-edge.ts`。

## 上生产前 checklist

- [ ] `ssr.config.ts runtime.site` 设到真实公网域名
- [ ] `ssr.config.ts` 的 `runtime.redis.url` 读取 `process.env.REDIS_URL`，并在部署平台把 `REDIS_URL` 设到生产 Redis（多 pod 必需）
- [ ] Rate limit 在 CDN/WAF 层配置（Cloudflare WAF / AWS WAF / Vercel Edge / Kong）
- [ ] 如需 Sentry，配置 `runtime.telemetry.integrations.sentry.enabled=true` 并注入 `SENTRY_DSN`
- [ ] `ISR_OPS_TOKEN` 设到强 secret（如果生产开启 `/metrics`）
- [ ] 跑一周以上 staging 压测，监控内存增长（L1 LRU 默认 1000 条够不够你的业务）
- [ ] 跑全量 SSG spider 验证（`pnpm vite build`），确认 `ssg.routes` 列表里没有失败 URL
- [ ] 验证 `revalidateTag` 在 staging 多 pod 下会通过 Redis Pub/Sub 广播（见 [caching.md#cross-pod-invalidation](./caching.md#cross-pod-invalidation)）
- [ ] 确认 graceful shutdown 在 SIGTERM 下 < 3s 退出（k8s preStop hook 至少给 10s）

## Origin 协议

Engine origin 只启动 HTTP/1.1。TLS / HTTP/2 / HTTP/3 应该在 CDN / Nginx /
Caddy / ALB 终结后回源 HTTP/1.1：

```txt
Browser -- HTTP/2/HTTP/3 --> CDN / Nginx / Caddy / ALB -- HTTP/1.1 --> novel-isr Node origin
```

Node + Express 不是 HTTP/2 一等运行时，origin 直出协议升级是负担、不是卖点。
公网入口的 slowloris / header DoS / keep-alive 耗尽防护，靠上游代理和 engine 内部
HTTP timeout 默认值配合做；业务项目不需要维护 Node timeout 字段。

## 进一步

- 详细 fallback 行为：[deployment/ssr-spa-failover.md](./deployment/ssr-spa-failover.md)
