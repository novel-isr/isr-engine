# Dev Render Inspector

`Novel ISR Inspector` 是 engine 内置的开发态渲染检查器。它跟随
`@novel-isr/engine` 的 client runtime 自动注入，不应该由业务项目手写或 import。

## 为什么属于 engine

它展示的是 engine 协议状态，不是业务 UI：

- `x-resolved-mode`：当前请求解析出的用户级模式，`isr` / `ssr` / `ssg`
- `x-render-strategy`：实际渲染策略，例如 `rsc-ssr` / `csr-shell`
- `x-cache-status`：缓存状态，`HIT` / `MISS` / `STALE` / `BYPASS`
- `x-fallback-used`：是否进入 fallback
- `content-language`：本次请求的 locale
- `x-i18n-source`：i18n 字典来源，例如 `admin` / `local-fallback`

这些状态由 engine 的 RSC、SSR、缓存、fallback、SiteHooks 一起决定。放在业务层会产生
重复心智负担，也容易和业务样式、路由树、Server Component 边界耦合。

## 默认行为

`pnpm dev` 时默认启用。生产构建不会显示。

浮层使用 Shadow DOM 隔离样式，不污染业务 CSS；它在 client runtime 启动早期挂载，
先于 RSC payload 反序列化和 `hydrateRoot`。因此即使首屏水合、RSC 请求或动态 import
先失败，开发者仍然能看到本次请求的真实渲染模式和缓存状态。它不进入业务 RSC 树，
也不会影响页面的 Server Component import Client Component 边界。

## 关闭方式

关闭它要写在 **client entry**：

```ts
// src/entry.tsx
export default {
  devInspector: false,
};
```

`src/entry.tsx` 是浏览器侧 hooks 的入口，适合放：

- `devInspector`
- `beforeStart`
- `onNavigate`
- `onActionError`

不要写到 `src/entry.server.tsx`：

```ts
// ❌ 不会生效，也不应该这样设计
export default defineSiteHooks({
  devInspector: false,
});
```

`entry.server.tsx` 只在 server/RSC 环境执行，承载 i18n、SEO、request hooks 和数据
loader。Redis、Sentry、A/B 等平台配置推荐放在 `ssr.config.ts` 的 `runtime`。
把 client-only 开关塞进 server entry 会让配置边界变模糊，也可能诱导浏览器 bundle
误引用服务端代码。

如果未来需要全局公共开关，成熟设计应该是放到 `ssr.config.ts` 的 client-safe public config，
再由 engine 插件注入浏览器环境，而不是让 client 直接 import server entry。

## 模式切换是否保真

Inspector 不 mock、不伪造渲染模式。它只修改当前 URL 的调试参数：

- ISR：`?mode=isr`
- SSR：`?mode=ssr`
- SSG：`?mode=ssg`
- CSR fallback：`?__csr-shell=1`

请求仍然走真实 engine 中间件。判断以响应头为准：

```bash
curl -sS -D - 'http://localhost:3000/?mode=isr' -o /dev/null
# x-resolved-mode: isr
# x-render-strategy: rsc-ssr
# x-cache-status: MISS|HIT|STALE
```

注意：SSR 显示 `BYPASS` 是正确语义。SSR 每次请求都实时渲染，按设计不写页面缓存。

## i18n 来源

Inspector 显示 `content-language · x-i18n-source`。

- `remote`：本次请求字典来自 API 远端下发
- `local-fallback`：远端不可用或未配置时，业务自己的本地 fallback 生效
- `-`：项目未返回来源字段

`x-i18n-source` 只是诊断字段，不参与业务渲染。真正渲染仍然来自 RSC payload 中的
`intl.messages`，客户端水合和客户端导航都会复用同一套 payload。
