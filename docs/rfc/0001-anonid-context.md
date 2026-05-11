# RFC 0001 — anonId + Server Request Context

| 字段 | 值 |
|---|---|
| Status | **Implemented** (engine ≥ `b63dd80`) |
| Author | engine 维护组 |
| Created | 2026-05-11 |
| Updated | 2026-05-12 |

## TL;DR

把 A/B 实验的 **identity（anonId）** 与 **variant assignment（hash 分桶）** 在数据模型和代码路径上彻底分离。结果：

- 业务侧 `getVariant('hero-style')` 调用方式不变
- ISR cache 不再被 Set-Cookie 击穿 —— cookieless 请求二次访问 HIT
- 加 / 改 / 停实验不需要重写用户 cookie
- 整套机制 0 第三方依赖

旧实现把变体编码进 cookie（`ab=hero=bold|pricing=control`），每次实验配置变就要 rewrite cookie → 响应带 Set-Cookie → cache 严格拒绝入库 → 全站任何启用实验的路由退化成 SSR。这是 RFC 要解决的根问题。

## 1. 设计原则

### 1.1 三 ID 模型

| ID | 生命周期 | 来源 | 持久化形式 | 主要用途 |
|---|---|---|---|---|
| `requestId` | 单次请求 | engine 生成 / X-Request-Id 头 | 仅响应头 `x-request-id` | log / trace 关联 |
| `traceId` | 单次请求 | W3C `traceparent` / 生成 | 仅响应头 / OTel 透传 | 跨服务追踪 |
| `anonId` | 永久（1 年） | cookie `anon` / engine 兜底生成 | cookie `anon=UUID` | A/B 桶分配、telemetry 用户聚合、个性化锚点 |
| `userId` | 登录态绑定 | 业务侧 `beforeRequest` 写入 | session token（业务侧管） | 已登录用户身份 |

四个字段全部在 `ISRContextData`（AsyncLocalStorage 存的 record），通过 `getRequestContext()` 在任意 RSC / Server Action 同步读取。

### 1.2 Assignment 与 Resolution 强制分离

A/B 的两个动作必须在**不同时刻、不同代码路径**完成：

| 动作 | 含义 | 频率 | 是否写 Set-Cookie |
|---|---|---|---|
| **Assignment** | 用户首次访问时分到一个 bucket（识别身份） | 一辈子一次 | **要写**（仅 `anon=UUID`） |
| **Resolution** | 渲染页面时把 bucket 翻译成 variant | 每次请求 | **绝对不写** |

把这两件事塞进同一个 render pass 是死局 —— 页面响应必带 Set-Cookie，共享缓存必拒绝。这是 RFC 7234 / 9111 的硬约束，工程层面没有迂回空间。

### 1.3 确定性 hash 分桶

```
variant = pickByWeight(
  exp.variants,
  exp.weights,
  fnv1a32(anonId + ':' + experimentKey) % BUCKET_SPACE
)
```

- 同 anonId × 同实验 → 永远同 variant（SEO / UX 一致）
- 同 anonId × 不同实验 → 各自独立分桶
- 不同 anonId × 同实验 → 按 weights 比例分散到不同 bucket
- 升级实验配置 → 仅 weights 变化的边界用户重新分桶，其余稳定

`BUCKET_SPACE = 10000` 提供 0.01% 权重精度，业界通行。`FNV-1a 32 位` hash 算法在 `src/utils/hash.ts`，无 crypto 依赖、确定性、雪崩效应足够好。

## 2. 数据模型

### 2.1 `ISRContextData`

```ts
export interface ISRContextData {
  // ─── 永远非空（engine 入口 createServerRequestContext 保证）───
  traceId: string;
  requestId: string;
  anonId: string;

  // ─── 可能为空（登录态 / 业务侧 hook 写入）───
  userId?: string;
  sessionToken?: string;
  sessionUser?: { ... };

  // ─── 解析视图 ───
  cookies?: Record<string, string>;

  // ─── A/B 实验结果（ABVariantMiddleware 写入）───
  experiments?: Record<string, string>;   // 本次请求所有变体
  flags?: Record<string, boolean | string>; // 历史 API 兼容路径

  [key: string]: unknown;
}
```

### 2.2 `anon` Cookie

| 字段 | 值 |
|---|---|
| 名称 | `anon` |
| 值 | RFC 4122 v4 UUID（`crypto.randomUUID()`） |
| Max-Age | `31536000`（365d） |
| Path | `/` |
| SameSite | `Lax` |
| HttpOnly | **false**（让客户端 SDK 能读，做 conversion 上报关联 anonId） |
| Secure | 不强制（生产环境由反向代理 / CDN 加） |

**只在 cookie 缺失时落一次**。已存在则只读不写 —— ISR cache 在 captureAndStore 阶段会把 anon Set-Cookie 从存储 headers 里剥掉，cache entry user-agnostic。

## 3. 请求流（精确顺序）

```
[Request]
   ↓
①[security + compression]                    ←  engine 既有
   ↓
②[createServerRequestContext]                ← RFC 0001 核心
   - parseCookieHeader → cookies map
   - anonId = cookies['anon'] ?? randomUUID()
   - needsAnonCookie = !cookies['anon']
   - ctx.data = { traceId, requestId, anonId, cookies }
   - 若 needsAnonCookie: applyAnonCookie(res, anonId)
     → res.appendHeader('Set-Cookie', 'anon=...; Max-Age=...; ...')
   ↓
③[LocaleRedirect]                            ← engine 既有
   ↓
④[ABVariantMiddleware]                       ← RFC 0001 重构
   - 对每个 active experiment：
       bucket = fnv1a32(anonId + ':' + key) % 10000
       variant = pickByBucket(variants, weights, bucket)
   - ctx.experiments[key] = variant
   - ctx.flags[key] = variant（兼容历史 getVariant）
   - ★ 完全不写 Set-Cookie ★
   ↓
⑤[SSG static] [express.static] [image]       ← engine 既有
   ↓
⑥[ISR Cache middleware]                      ← RFC 0001 修改
   - cacheKey = ${url}|v=${fnv1a32Base36(sortedExperiments)}
   - HIT → 回放 cached body（cached headers 已剥 anon Set-Cookie）
   - MISS → 渲染 → captureAndStore
       stripBootstrapAnonCookie(captured.headers)
       if hasSetCookie(headers): skip cache（业务 session 等仍拒绝入缓存）
       else: store
   ↓
⑦[Render via plugin-rsc]                     ← engine 既有
   ↓
[Response 出客户端]
   - 首次访问：body + Set-Cookie: anon=...
   - 后续访问：body 无 Set-Cookie（cache HIT）
```

## 4. 缓存不变量

| 场景 | 客户端响应 | cache 入库内容 |
|---|---|---|
| 首次（无 anon cookie）+ 无 active 实验 | body + `Set-Cookie: anon=UUID` | body + headers（剥 anon Set-Cookie 后） |
| 首次 + 有 active 实验 | 同上，variant 由 hash 决定 | 同上，cache key 含 `\|v=...` |
| 二次（有 anon cookie）+ 同变体 | body 无 Set-Cookie | cache HIT |
| 二次（有 anon cookie）+ 实验改变 | MISS → 渲染 → 入新桶 | 新 cache entry |
| 业务渲染期 `res.appendHeader('Set-Cookie', 'session=...')` | body + Set-Cookie | **仍然拒绝缓存** —— `hasSetCookie` 在 strip anon 之后仍判 true |

第 5 行（业务自己写 session cookie）是必须保留的安全边界 —— 业务态响应入缓存会导致跨用户会话泄露。

## 5. API Surface

### 5.1 配置（`ssr.config.ts`）

```ts
import { defineIsrConfig } from '@novel-isr/engine/config';

export default defineIsrConfig({
  runtime: {
    experiments: {
      'hero-style': { variants: ['classic', 'bold'], weights: [50, 50] },
      'pricing-cta': { variants: ['control', 'discount'], weights: [70, 30] },
    },
    // RFC 0002 引入的字段在那里描述；本 RFC 仅声明 experiments 静态形态
  },
});
```

### 5.2 RSC 同步读

```ts
import {
  getVariant,        // 读单个实验变体
  getExperiments,    // 读全部实验变体表
  getAnonId,         // 浏览器 UUID（永远非空）
  getUserId,         // 已登录用户 ID（未登录 null）
  getRequestId,      // 本次请求 ID
  getTraceId,        // W3C trace 上下文
  getRequestContext, // 全部 ctx
} from '@novel-isr/engine/rsc';

export default async function HomePage() {
  const variant = getVariant('hero-style') ?? 'classic'; // 永远 fallback
  return variant === 'bold' ? <HeroBold /> : <HeroClassic />;
}
```

### 5.3 自定义 assigner

```ts
import { createABVariantMiddleware } from '@novel-isr/engine';

createABVariantMiddleware({
  experiments: { ... },
  assigner: (anonId, name, exp) => {
    // 必须是确定性函数；同输入永远同输出
    // 示例：按 anonId hash + 地理位置叠加
    const baseBucket = fnv1a32(anonId + ':' + name) % 10000;
    if (isAsiaPacific(anonId) && name === 'pricing-cta') return 'discount';
    return pickByBucket(exp.variants, exp.weights, baseBucket);
  },
});
```

## 6. 测试覆盖

`src/middlewares/__tests__/ABVariantMiddleware.test.ts` 7 个单测：

1. 同 anonId 同实验 → 永远同一 variant（确定性）
2. 不同 anonId 在 50/50 实验上分散到两个 variant
3. weights 0/100 → 永远 v2，跟 anonId 无关
4. **完全不写 cookie**（ISR cache 友好的核心不变量）
5. 多实验在同一 anonId 上独立分配，写到 ctx.experiments + ctx.flags
6. 自定义 assigner 覆盖默认 hash
7. getVariant 在 RequestContext 外 → undefined

`src/utils/__tests__/hash.test.ts`（计划）覆盖 FNV-1a 边界（空串、长串、unicode、雪崩）。

## 7. 兼容性 & 迁移

### 7.1 对业务侧

- `getVariant(name)` API 完全保持兼容，业务代码 0 改动
- 旧 `ab` cookie 在引擎升级后自动失效（不再读，不再写），用户在下次访问时通过新的 `anon` cookie 重新进入实验。**变体可能跟以前不同** —— 设计上接受，因为业界惯例是变体 hash 由 (userId, expKey) 决定，cookie 形态变化等价于换了一套实验
- ISR cache 在升级后冷启一次，所有 cache entry 重建

### 7.2 对配置侧

- `runtime.experiments` 字段保留，shape 不变
- `runtime.experiments` 为空（`{}`）→ ABVariantMiddleware 不挂载，与旧版无差异行为
- `getVariant` 在没配 experiments 时返回 undefined（一直如此）

## 8. 已知约束 & 不在 RFC 范围

| 约束 / 缺口 | 解决在 |
|---|---|
| 实验定义在 `ssr.config.ts`，改实验需要重启 | RFC 0002 manifest 拉取 |
| 没有曝光上报（render 完成 ≠ 数据库记录） | RFC 0002 exposure tracking |
| 没有 targeting（path / locale / userId 范围） | RFC 0002 targeting rules |
| 灰度 ramp / kill switch 没有运行时控制 | RFC 0002 canary primitives |
| Bot / cookieless 流量首次访问拿到 Set-Cookie，CDN 不缓存首响应 | 接受现状，长期可在 edge 层做 anonId 分配 |
| 第一次访问的 cache 是 user-agnostic，但下一秒变体计算才落地 → 首响应可能命中默认 variant | 当前实现没有这个问题（首响应已用 hash(anonId) 算变体） |

## 9. 相关代码

- `src/types/ISRContext.ts` — ISRContextData type
- `src/context/createServerRequestContext.ts` — 三 ID 生成工厂 + cookie 落点
- `src/context/RequestContext.ts` — AsyncLocalStorage + getter helpers
- `src/middlewares/ABVariantMiddleware.ts` — 确定性 hash 分桶
- `src/middlewares/abVariantContext.ts` — `getVariant` RSC export
- `src/plugin/isrCacheMiddleware.ts:stripBootstrapAnonCookie` — Set-Cookie strip
- `src/plugin/isrCacheMiddleware.ts:extractVariantDigest` — cache key digest
- `src/utils/hash.ts` — FNV-1a hash
- `src/rsc/index.ts` — 公开 API 出口
