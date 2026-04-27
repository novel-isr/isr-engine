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
       → ISR cache → protected admin endpoints → catch-all RSC handler
```

## 生产环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `PORT` | 监听端口（默认 3000） | `PORT=8080` |
| `NODE_ENV` | 必须 `production` | 自动 |
| `SEO_BASE_URL` | sitemap 域名 | `https://my-app.com` |
| `PUBLIC_BASE_URL` | 同上备选 | 同上 |
| `BASE_URL` | 同上备选 | 同上 |
| `API_URL` | 上游 API 基址 | `https://api.internal/v1` |
| `REDIS_URL` | Redis L2 缓存（可选） | `redis://...:6379/0` |
| `SENTRY_DSN` | Sentry（可选） | `https://...@sentry.io/...` |
| `ISR_ADMIN_TOKEN` | `/__isr/*` / `/metrics` 鉴权（如果开启） | 任意 secret |

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
| `/__isr/stats` | 开 | 默认不注册（需显式开 + token） |
| `/__isr/clear` | 开 | 默认不注册（需显式开 + token） |
| `/metrics` | 开 | 默认不注册（需显式开 + token） |

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

## Middleware（i18n / A/B / rate-limit）

i18n / A/B / rate-limit 这类横切逻辑通过 SiteHooks 的 `beforeRequest` 实现，详见
[site-hooks.md](./site-hooks.md)。Vercel Edge 部署可用 `toVercelMiddleware` 包出
平台原生 `middleware.ts`，详见 `src/adapters/runtime/vercel-edge.ts`。

## 上生产前 checklist

- [ ] `SEO_BASE_URL` 设到真实域名
- [ ] `REDIS_URL` 设到生产 Redis（多 pod 必需）
- [ ] `SENTRY_DSN` 接入（一行 `createSentryServerHooks`）
- [ ] `ISR_ADMIN_TOKEN` 设到强 secret（如果开了 `/__isr/*` 或 `/metrics`）
- [ ] 跑一周以上 staging 压测，监控内存增长（L1 LRU 默认 1000 条够不够你的业务）
- [ ] 跑全量 SSG spider 验证（`pnpm vite build`），确认 `ssg.routes` 列表里没有失败 URL
- [ ] 验证 `revalidateTag` 在 staging 多 pod 下会通过 Redis Pub/Sub 广播（见 [caching.md#cross-pod-invalidation](./caching.md#cross-pod-invalidation)）
- [ ] 确认 graceful shutdown 在 SIGTERM 下 < 3s 退出（k8s preStop hook 至少给 10s）

## Origin 协议

Engine origin 只支持 `http1.1` / `https`。HTTP/2 / HTTP/3 应该在 CDN / Nginx /
Caddy / ALB 终结后回源 HTTP/1.1：

```txt
Browser -- HTTP/2/HTTP/3 --> CDN / Nginx / Caddy / ALB -- HTTP/1.1 --> novel-isr Node origin
```

Node + Express 不是 HTTP/2 一等运行时，origin 直出协议升级是负担、不是卖点。
公网入口的 slowloris / header DoS / keep-alive 耗尽防护，靠上游代理 + `server.timeouts`
配合做。

## 进一步

- 详细 fallback 行为：[deployment/ssr-spa-failover.md](./deployment/ssr-spa-failover.md)
