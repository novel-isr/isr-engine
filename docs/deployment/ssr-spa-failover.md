# SSR ↔ SPA 降级 —— 部署架构指南

**框架不做 SPA 降级**，因为这是部署层（CDN / Edge / Service Worker）的事。Next.js / Remix / Modern.js 都是同样原则。本文档讲业界三种主流模式 + 完整可用配置。

## 总览

```
浏览器 → CDN(Cloudflare/Vercel/Akamai) → Nginx → SSR Origin (本框架)
              │                          │              │
       SPA fallback HTML              error_page    实际 RSC 渲染
       (origin 5xx 时返回)         (5xx 时返回 SPA)
              │
       Service Worker (浏览器侧离线缓存)
```

framework 的责任：
- 提供 SSR HTML（健康时）
- 提供静态 csr-shell HTML（renderToReadableStream 抛错时）
- 把 SPA bundle 一并 build 出来供 CDN/Nginx 使用

部署层的责任：
- 把 5xx 替换为 SPA HTML
- 把 SPA 资源 cache 在 CDN 边缘 / Service Worker

## 模式 A：CDN 边缘 failover（推荐 / OKX/Vercel 用）

### Cloudflare Workers

```ts
// worker.ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const r = await fetch(req, { signal: AbortSignal.timeout(3000) });
      if (r.status >= 500) throw new Error(`origin 5xx: ${r.status}`);
      return r;
    } catch {
      // origin 挂了 → 返回预部署的 SPA HTML
      return env.ASSETS.fetch(new Request('https://example.com/spa.html'));
    }
  },
};
```

部署 SPA HTML：在 `wrangler.toml` 配 `[site] bucket = "./dist/spa"`。

### Vercel rewrites

```json
// vercel.json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/api/ssr/$1" }
  ],
  "headers": [{
    "source": "/(.*)",
    "headers": [{ "key": "x-vercel-cache", "value": "miss" }]
  }],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/api/ssr/$1",
      "continue": true
    },
    { "src": "/(.*)", "dest": "/spa.html", "status": 200 }
  ]
}
```

## 模式 B：Nginx error_page（自管 origin 推荐）

```nginx
# /etc/nginx/sites-available/example.com
upstream ssr_backend {
  server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;
  server 127.0.0.1:3001 max_fails=3 fail_timeout=10s; # 多实例
  keepalive 64;
}

server {
  listen 443 ssl http2;
  server_name www.example.com;

  ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

  # 静态资源永不走 SSR
  location /assets/ {
    root /var/www/dist/client;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # 页面：先 SSR，5xx → SPA fallback
  location / {
    proxy_pass http://ssr_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 5s;
    proxy_connect_timeout 2s;

    proxy_intercept_errors on;
    proxy_next_upstream error timeout http_502 http_503 http_504;
    error_page 500 502 503 504 = @spa_fallback;
  }

  location @spa_fallback {
    root /var/www/dist/spa;
    try_files /index.html =503;
    add_header X-Served-By "spa-fallback" always;
    add_header Cache-Control "no-store" always;
  }

  # API 反向代理（同域避 CORS）
  location /api/ {
    proxy_pass https://api-backend.internal:443;
    proxy_set_header Host api-backend.internal;
  }
}
```

**SPA bundle 怎么构建**：单独跑一份纯 SPA 项目（用 `vite build`，无 plugin-rsc），输出到 `/var/www/dist/spa/`。本框架 dist 不含 SPA bundle —— 你 build 一份并行的。

## 模式 C：Service Worker（OKX 交易页用）

### 注册 SW（在 entry.tsx 的 beforeHydrate 里）

```ts
export default {
  beforeHydrate: () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js');
    }
  },
};
```

### sw.js（手写 / Workbox 生成）

```js
const SHELL = '/spa.html';
const CACHE_VERSION = 'v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll([SHELL, '/assets/spa.js'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(SHELL))
    );
  }
});
```

**效果**：第一次访问 SSR 正常，SW 缓存 SPA shell。SSR 挂时 SW 直接返回 shell，浏览器加载 SPA bundle，**用户感觉不到 SSR 死了**。

## 三种模式对比

| 模式 | 复杂度 | 用户体验 | 适用 |
|------|-------|---------|------|
| A. CDN 边缘 | 低 | ★★★ 平滑 | 用 CDN 的项目（多数） |
| B. Nginx error_page | 中 | ★★ 偶有抖动 | 自管基础设施 |
| C. Service Worker | 高 | ★★★★ 完全无感 | 重交互应用（交易/IM）|

**推荐**：A + C 组合。CDN 应付边缘场景，SW 应付浏览器侧极端情况。

## 框架 csr-shell 的角色

`isr-engine` 内置静态降级页（`服务暂时不可用` + 重新加载按钮）—— **设计角色是「最后兜底」**：

```
浏览器 → [CDN 失败] → [Nginx 失败] → [SW 失败] → SSR 5xx → csr-shell
```

正常生产部署 csr-shell **永远不该被用户看到**。如果看到了，说明你的部署架构有重大问题（CDN/SW 都没配）。Next.js 的 `_error.js` 是同款角色。

## SPA bundle 怎么构建（与 SSR 共享代码）

最佳实践：**两个 vite 配置，共享 src/**：

```ts
// vite.config.ssr.ts —— 当前 isr-engine 的配置
export default defineConfig({
  plugins: [...createIsrPlugin()],
});

// vite.config.spa.ts —— 单独 SPA 构建
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/spa',
    rollupOptions: { input: 'spa-entry.tsx' },
  },
});
```

```tsx
// spa-entry.tsx —— SPA 主入口
import { createRoot } from 'react-dom/client';
import { SpaRoot } from './src/spa-root'; // 用户的 SPA 根（用 'use client' 组件 + SWR/React Query 拉数据）
createRoot(document.getElementById('root')!).render(<SpaRoot />);
```

构建：
```bash
pnpm build               # SSR + RSC bundle (输出 dist/{rsc,client,ssr}/)
pnpm vite build -c vite.config.spa.ts   # SPA bundle (输出 dist/spa/)
```

部署：把 `dist/client/` 和 `dist/spa/` 都 push 到 CDN/static host，Nginx error_page 引用 `dist/spa/index.html`。

## 总结

| 责任 | 谁做 |
|------|------|
| RSC 渲染、ISR 缓存、Server Actions | **isr-engine** |
| SPA bundle 构建 | 用户 + Vite (单独 config) |
| 5xx → SPA HTML 切换 | CDN / Nginx / Service Worker |
| 用户离线缓存 | Service Worker |

**框架不替代部署架构**。当前 isr-engine 设计与 Next.js / Remix / Modern.js 一致。
