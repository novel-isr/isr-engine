# Verifying RSC Works

如何验证你的 Server Components 真的把 server 代码留在了 server 上。

## 目标

确认下面三件事：

1. **Network 面板里看不到上游 API** —— Server Component 在 server 端 fetch，浏览器只看到最终的 RSC payload
2. **页面源代码里看不到 server-only 字段** —— 比如 API key、内部数据库 schema、推荐算法参数
3. **Client bundle 里看不到 server 模块代码** —— 比如 fetch 上游的逻辑、密钥常量

## Demo: 一个 Server Component

```tsx
// src/pages/HomePage.tsx —— 无指令 = Server Component
import { cacheTag } from '@novel-isr/engine/rsc';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY!;   // 永远不到客户端

export default async function HomePage() {
  cacheTag('books');
  const r = await fetch('https://internal-api/books', {
    headers: { 'X-API-Key': INTERNAL_API_KEY },
  });
  const data = await r.json();
  return <BookList books={data.books} />;
}
```

启动：

```bash
pnpm dev
# → http://localhost:3000
```

## 验证 1: Network 面板看不到上游 API

打开 DevTools → Network → 刷新 `/`：

| 应该看到 | ✅ |
|---|---|
| 主页请求 `GET /` | ✅ |
| Asset chunks (`/assets/*.js`, `*.css`) | ✅ |
| Server Action RPC（如果触发了交互）→ `POST /<route>?_action=...` | ✅ |
| 客户端导航 → `GET /<path>?_rsc=...` 或 `<path>_.rsc` | ✅ |

| 不应该看到 | ❌ |
|---|---|
| `GET https://internal-api/books`（上游 API 直链） | ❌ |
| 任何带内部 token / cookie 的 outbound 请求 | ❌ |

**为什么**：`fetch('https://internal-api/...')` 是在 Node 进程里跑的，浏览器看不到。

## 验证 2: 页面源代码不含 server-only 字段

右键 → 查看页面源代码（或 `curl http://localhost:3000/`）：

```bash
# ✅ 渲染好的数据在 HTML 里
curl -sS http://localhost:3000/ | grep "诡秘之主"

# ❌ 0 命中：API key 永远不进 HTML
curl -sS http://localhost:3000/ | grep "INTERNAL_API_KEY"

# ❌ 0 命中：内部 schema 字段不进 HTML
curl -sS http://localhost:3000/ | grep -i "internal_db_id\|secret\|password"
```

如果 grep 出来了——说明你不小心把 server-only 数据当 prop 透给了 Client Component。Client Component 的 prop 会序列化进 RSC payload + HTML。

## 验证 3: Client bundle 不含 server 模块

```bash
pnpm vite build
ls dist/client/assets/*.js | xargs grep -l "internal-api"
# 应为空：上游 fetch 逻辑只在 dist/rsc 和 dist/ssr 里
```

如果某个 Client Component 误 `import` 了 server-only 模块，会直接构建报错——`@vitejs/plugin-rsc` 在两端 bundle 边界做了校验。

## 验证 4: RSC payload (Flight 流) 也不泄露

Flight 流在 `<path>_.rsc` 路径上：

```bash
curl -sS http://localhost:3000/_.rsc | strings | grep "INTERNAL_API_KEY"
# 0 命中
```

Flight 协议序列化的是**渲染后的 VDOM 树**，不是 server module 的源码或闭包变量。

## 验证 5: csr-shell 兜底

服务端崩溃时不会把 5xx 抛给用户。临时在 `app.tsx` 顶部加：

```tsx
if (url.searchParams.get('__crash') === '1') throw new Error('test');
```

```bash
curl -I 'http://localhost:3000/?__crash=1'
# HTTP/1.1 200 OK
# x-render-strategy: csr-shell
```

浏览器看到："服务端暂时不可用，正在尝试客户端加载…" 然后立刻自动调 `_.rsc` 拉真实数据填充。

## 常见误区

### "我用 'use client' 就够了"

错。`'use client'` 只是把组件标成可在浏览器 hydrate 的边界。**它不会自动把 server 数据隔离**。如果你写：

```tsx
'use client';
const API_KEY = process.env.INTERNAL_API_KEY;   // ⚠️ 这会进 client bundle！
```

`process.env.*` 在 `'use client'` 文件里会被构建期内联——任何不带 `VITE_` / `NEXT_PUBLIC_` 前缀的常量都不应该出现在 client 文件。

### "Server Action 里的 console.log 浏览器看得到吗？"

看不到。Server Action 是 server 端跑的——`console.log` 落到 server stdout，不传回浏览器。

### "Server Component 能用 React hooks 吗？"

不能用 `useState` / `useEffect` / `useRef`。可以用 React 19 新的 `use()` 解 Promise（Server Component async 直接 await 更常见）。

## 标签失效演示

```ts
// 在 Server Component 渲染时声明
import { cacheTag } from '@novel-isr/engine/rsc';
cacheTag('posts');

// 在 Server Action 里失效
'use server';
import { revalidateTag } from '@novel-isr/engine/rsc';
export async function publishPost() {
  // ... write db
  await revalidateTag('posts');   // 所有打了 'posts' tag 的缓存条目精准清除
}
```

详细：[caching.md](./caching.md)。

## 复杂排错

如果 RSC 行为怪异——刷新没反应、HMR 不生效、双 React 实例等——见 [troubleshooting.md](./troubleshooting.md)。
