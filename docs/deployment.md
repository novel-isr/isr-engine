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

## Middleware (i18n / A/B / rate-limit)

```ts
// middleware.ts —— 仓库根目录，engine 自动加载
export const config = { matcher: ['/((?!_/|__isr/).*)'] };

export default function middleware(req: Request) {
  const { pathname } = new URL(req.url);
  if (/^\/(en|zh|fr)\//.test(pathname)) return;   // 已带 locale，放行
  const locale = pickLocale(req.headers.get('accept-language'));
  return Response.redirect(new URL(`/${locale}${pathname}`, req.url), 302);
}
```

支持 `matcher` / `next()` 链式协议（Next.js 风格）。

## 上生产前 checklist

- [ ] `SEO_BASE_URL` 设到真实域名
- [ ] `REDIS_URL` 设到生产 Redis（多 pod 必需）
- [ ] `SENTRY_DSN` 接入（一行 `createSentryServerHooks`）
- [ ] `ISR_ADMIN_TOKEN` 设到强 secret（如果开了 `/__isr/*` 或 `/metrics`）
- [ ] 跑一周以上 staging 压测，监控内存增长（L1 LRU 默认 1000 条够不够你的业务）
- [ ] 跑全量 SSG spider 验证（`pnpm vite build`），确认 `ssg.routes` 列表里没有失败 URL
- [ ] 验证 `revalidateTag` 在 staging 多 pod 下会通过 Redis Pub/Sub 广播（见 [caching.md#cross-pod-invalidation](./caching.md#cross-pod-invalidation)）
- [ ] 确认 graceful shutdown 在 SIGTERM 下 < 3s 退出（k8s preStop hook 至少给 10s）

## HTTP/2 / HTTP/3 production stance

推荐拓扑：

```txt
Browser -- HTTP/2/HTTP/3 --> CDN / Nginx / Caddy / ALB -- HTTP/1.1 --> novel-isr Node origin
```

原因：

- Node + Express 对 HTTP/2 不是一等运行时；engine 的 `protocol: 'http2'` 适合受控环境验证，不建议未经压测直接暴露公网。
- `protocol: 'http3'` 只有在真实 QUIC 实现可用时才发送 `Alt-Svc`。没有 QUIC 时会降级为 HTTP/2 TLS，且不广播 HTTP/3，避免客户端被误导。
- origin 侧新增 `server.timeouts` / `server.http2` 配置，用于限制慢请求、header 资源消耗、keep-alive 连接和 HTTP/2 stream 并发。公网入口仍应由上游代理承担第一层防护。

## 进一步

- 详细 fallback 行为：[deployment/ssr-spa-failover.md](./deployment/ssr-spa-failover.md)
