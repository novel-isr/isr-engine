# 社区发布说明（v2.3.1）—— 求拍砖向

> **这是一个面向 Vite 中文社区 / `vite-rsc` 早期使用者的 RFC 性质介绍**。
> 直接复制到群聊 / GitHub Discussions / X 即可。
> 心态：**找拍砖**，不是宣传成熟产品。

---

## 一句话

> 在 `@vitejs/plugin-rsc` 之上加一层 ISR / SSG / Fallback 编排层（Vite 8 + React 19 + Express 5）。
> 不手写 Flight 协议、不造路由器、不绑业务。alpha 阶段，求 Vite 社区一起 review 是不是
> 在做正确的事。

仓库：（待用户填）  
包：`@novel-isr/engine`（GitHub Packages，scope 名只是首发项目代号，与小说业务**无任何耦合**）  
当前版本：**v2.3.1**

---

## 解决什么问题（动机）

我在做一个 React 19 RSC 的站点，想要的是「Next.js App Router 的开发体验，
但底下是 Vite」。看了下选项：

| | 现状 | 我的不满 |
|---|---|---|
| Next.js App Router | 成熟、文档全 | webpack/Turbopack；segment config 隐式；HMR 比 Vite 慢 |
| [Waku](https://github.com/dai-shi/waku) | Vite + RSC | 没有 ISR 缓存层 / `revalidatePath` / `cacheTag` |
| RedwoodJS | RSC 实验中 | 绑定自家全栈 |
| 直接用 [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) | 最干净 | 只解决 RSC 协议，ISR / SSG / SEO / i18n 都得自己写 |

所以做了 `isr-engine`：把 plugin-rsc 之上的「中等规模业务该有的横切能力」
固化成一个 Vite 插件 + 一个 Express 5 进程，让业务只写
**`src/app.tsx` + 路由表 + 一个 `siteHooks` 配置**。

> Flight 协议 / Server Action / `'use client'` 指令 / 三环境编译这些**完全交给
> 官方 `@vitejs/plugin-rsc`**，不重造、不分叉。

---

## 30 秒看明白（消费方代码）

```bash
pnpm add @novel-isr/engine react react-dom react-server-dom-webpack rsc-html-stream
pnpm add -D vite typescript @types/react @types/react-dom
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';
export default defineConfig({ plugins: [...createIsrPlugin()] });
```

```jsonc
// package.json
{ "scripts": { "dev": "novel-isr dev", "build": "vite build", "start": "novel-isr start" } }
```

```tsx
// src/app.tsx —— 唯一必需的应用代码
import { parseLocale } from '@novel-isr/engine/runtime';
import { routes } from './routes';

export function App({ url }: { url: URL }) {
  return (
    <html><body>
      {routes({ pathname: url.pathname, searchParams: url.searchParams })}
    </body></html>
  );
}
```

`pnpm dev` → http://localhost:3000。完事。

> v2.3.1 之前会在浏览器侧报 `does not provide an export named 'default' / 'jsxDEV'`
> （React 19 ESM 兼容缺陷）—— **这就是这次发版的核心修复**。

---

## 我希望社区帮我 review 的几个具体点

### 1. 「ISR 缓存层做在 Express 中间件」是不是合理？

`@novel-isr/engine` 在 `@vitejs/plugin-rsc` 之外起了一个 Express 5 进程跑 SSR + ISR。
缓存层是个 Express middleware：

- L1：进程内 LRU（lru-cache）
- L2：可选 Redis（Hybrid 写穿）
- TTL + SWR + tag-based 失效（`cacheTag('books')` + `revalidateTag('books')`）
- single-flight 防 thundering herd（v2.2 加的）

**问题**：Vite 8 引入了 environments API。我现在的 ISR cache 还是按
传统「Express + Vite middleware mode」做的，没用 environments / runtime API。

- 应该迁移到 environments 吗？
- 还是说 ISR 这种场景（需要持久化进程 + Redis 连接 + 中间件链）天然适合留在 Express？
- Edge runtime（CF Workers / Vercel）怎么对接才优雅？现在有 `adapters/runtime` 但只是套壳。

### 2. 路由器：自实现 70 行 vs 复用现成

```ts
// 当前实现
export const { routes } = defineRoutes({
  notFound: { load: () => import('./pages/NotFoundPage') },
  routes: [
    { path: '/', load: () => import('./pages/HomePage') },
    { path: '/books/:id', load: () => import('./pages/BookDetail') },
    { path: '/dashboard/*', load: () => import('./pages/Dashboard') },
  ],
});
```

`defineRoutes` 是 ~70 行的 path-to-regexp 包装器，就 `:param` + `/*` 通配。
没用 React Router 7 / TanStack Router / Waku 内置 router 是因为：
- 这些路由器都假设跑在 client 上，RSC 的 `async Server Component` 模式
  跟它们的 hooks API 对不上
- 想保持「路由表 = `(path, async page Component)`」这种 Next.js 式简洁

**问题**：是不是应该贡献到 plugin-rsc 而不是自己留一份？
还是说有更好的现成 RSC-native 路由器我没看到？

### 3. `csr-shell` fallback 这个概念

SSR 渲染挂掉时，engine 不返回 5xx，而是返回一个最小壳 HTML +
`self.__NO_HYDRATE=1` 让浏览器走 `createRoot` 自救拉 `_.rsc` 渲染。
类比 GitHub unicorn page / Twitter fail whale。

```
FallbackChain：
  isr  → cached → regenerate → server → csr-shell
  ssg  → static → regenerate → server → csr-shell
  ssr  →                       server → csr-shell
```

**问题**：
- 这个概念 Next.js / Waku / RedwoodJS 都没有。我自创术语是不是合理？
- 真正的生产事故下（server 完全挂了），这个降级链路有没有逻辑漏洞？
- 有没有相关 RFC / 论文可以对照参考？

### 4. 「engine 自带子路径 alias 到源 .tsx」这个历史决策

之前 `./client-entry` `./server-entry` `./runtime` 几个子路径 exports
直接指向 `src/.../*.tsx` 源文件，让消费方的 plugin-rsc 处理 JSX / 'use client' 指令。

这个决策有历史合理性（plugin-rsc 必须看到 `'use client'` 才能识别客户端边界，
bundle 后会丢），但**直接导致 v2.3.0 之前那个 React 默认导出报错**：
Vite scanner 不跟 `file://` URL 进入源文件 → React 没被预打包 → 浏览器拿到原始 CJS。

v2.3.1 我做了部分迁移：
- `./auto-observability` `./site-hooks`：纯逻辑，预打包到 `dist/*.js` ✅
- `./client-entry` `./server-entry`：依赖 `@vitejs/plugin-rsc/browser` `/rsc`
  虚拟模块，必须留源 ⚠️
- `./runtime`：内部混合多个带 `'use client'` 的模块，bundle 后丢指令，必须留源 ⚠️

**问题**：plugin-rsc 有没有官方推荐的 pattern 让一个**库**也能在打包后保留
模块级 `'use client'` 指令？或者 React 官方 RSC 库（如 `react-server-dom-webpack`）
是怎么解决这个问题的？

### 5. Express 5 + `@vitejs/plugin-rsc` 是不是兼容的最优解？

v2.3.1 把 express 4 → 5 升上去了，原因：
- 干掉 `pnpm.overrides path-to-regexp@<0.1.13`（4.x 解析到 8.x 会炸）
- 5.x 内置 path-to-regexp 6.x，干净
- 543 个测试全过 + novel-rating 项目 e2e 通过

**问题**：是不是其实该用 hono / itty-router / elysia 之类更现代的栈？
Express 在 2026 年还是合理选择吗？

---

## 当前真实状态（不粉饰）

| 项 | 状态 |
|---|---|
| 开发体验 | ✅ Vite 8 HMR、`pnpm dev` 真的开箱即用（v2.3.1 修完） |
| RSC 协议 | ✅ 完全委托 `@vitejs/plugin-rsc@^0.5.24`，跟官方升级 |
| ISR 缓存 | ✅ L1 + L2 + tag invalidation + single-flight + OOM 防御 |
| SSG | ✅ 构建期 spider 预生成；运行时 `express.static` 直发 |
| SEO / i18n | ✅ 声明式 `siteHooks`，pattern → meta 或 `{endpoint, transform}` |
| 测试 | ✅ 543 unit/integration（vitest），~50% 覆盖 |
| 浏览器 e2e | ❌ 没有 Playwright；靠手测 + curl smoke |
| 第二个独立项目 burn-in | ❌ 只有首发项目 novel-rating 在用 |
| 公开 npm | ❌ GitHub Packages restricted；社区试用需 GitHub PAT |
| API 稳定性 | ⚠️ alpha 阶段，1.0 之前可能有 BREAKING（CHANGELOG 标注，无 codemod） |
| bench 数据 | ⚠️ 单机 MacBook M-series 数据，GitHub runner ±60% 飘动；不能 release-gate |

---

## 我希望从社区拿到什么

1. **「正不正确做这件事」的高层评判** —— Waku 已经存在的情况下还要这个吗？
2. **架构盲点** —— 有没有我没看到的设计取舍坑？
3. **Vite 8 environments / runtime API 迁移建议** —— 现在 Express 中间件路线
   会不会两年后过时？
4. **生产案例对接** —— 有没有人愿意拿一个真业务跑一下，做 burn-in？
5. **plugin-rsc 上游** —— `@vitejs/plugin-rsc` 维护者愿不愿意给点反馈，
   说明 ISR / SSG / Fallback 这层是否应该进官方插件、还是留给生态自由实现？

---

## 沟通方式

- GitHub Issues / Discussions：（待用户填仓库链接）
- 代码 review：欢迎提 PR；CONTRIBUTING.md 在仓库根
- 直接拍砖：在群里 @ 我；接受**不留情面**的 review
- 不接受：「这功能 Next.js 也有所以没必要」（我知道，但我想要 Vite 体验）

---

## 不接受的批评（提前划清）

- ❌ 「叫 `@novel-isr` 是不是绑业务？」—— 这是 npm scope，不是产品名。
  grep 全仓源码无业务硬编码，运行时无业务假设。改名成本大于收益。
- ❌ 「为什么不用 Next.js？」—— 已在动机部分回答；如果你觉得 Next 已经够了，
  这个项目对你不适用，**不是错的**。
- ❌ 「为什么不直接 PR 到 plugin-rsc？」—— 见 review 点 #5。我希望先 RFC 验证
  方向再考虑上游。

---

> 最后：我是真心想把这个做成「Vite 生态里 ISR / SSG 的事实参考实现」之一。
> 但我也清楚自己只有一个项目在 burn-in，离 1.0 还远。所以发这个不是宣传，
> 是**邀请打脸**。
