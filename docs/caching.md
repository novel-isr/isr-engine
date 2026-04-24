# Caching & Invalidation

## 缓存键

ISR 缓存的 key 默认是 `${pathname}${querystring}`。每次请求都会先查 cache。响应头会告诉你命中了什么：

| 头 | 值 |
|---|---|
| `X-Cache-Status` | `HIT` / `MISS` / `STALE` / `BYPASS` / `REVALIDATING` |
| `X-Cache-Age` | 缓存条目年龄（秒；HIT/STALE 时） |
| `X-Cache-Key` | 缓存键（便于排错） |

## 标签失效

在 Server Component 渲染时**声明依赖**：

```tsx
// src/components/BookList.tsx
import { cacheTag } from '@novel-isr/engine/rsc';

export default async function BookList({ category }: { category?: string }) {
  cacheTag('books');                            // 通用：所有书库相关页面
  if (category) cacheTag(`books:${category}`);  // 分类粒度

  const books = await fetch('http://api/books').then(r => r.json());
  return <ul>{books.map(b => <li key={b.id}>{b.title}</li>)}</ul>;
}
```

在 Server Action 里**精准清除**：

```tsx
// src/actions/books.ts
'use server';
import { revalidateTag } from '@novel-isr/engine/rsc';

export async function publishBook(/* ... */) {
  // ... write db
  await revalidateTag('books');                  // 所有声明了 'books' 的页都清
}

export async function publishBookInCategory(category: string) {
  await revalidateTag(`books:${category}`);      // 只清这个分类的页
}
```

**为什么 tag 而不是 path**：当多个路由共享同一数据源（首页推荐 + 列表页 + 分类页都用书库），用 path 失效需要枚举每条路由，且新增路由容易漏。tag 把"数据源 → 页面"的关系倒过来声明。

## 路径失效

```tsx
'use server';
import { revalidatePath } from '@novel-isr/engine/rsc';

await revalidatePath('/books/123');
```

精确清除单个路径。少用——大部分场景 tag 更合适。

## markUncacheable

```tsx
import { markUncacheable } from '@novel-isr/engine/rsc';

if (!response.ok) {
  markUncacheable();   // 错误页不进缓存，下次请求重新渲染
  return <Error />;
}
```

防止把 5xx 或半成品页面写进缓存。

## L1 + L2 双层缓存（多 pod 部署必看）

默认 cache 是单层进程内 LRU——重启清零、多 pod 各持独立缓存。生产多实例部署接 Redis 走 L1+L2 双层（**sync 先查 L1**，**L1 miss 时 async 回源 L2 并回填本地 L1**，**write 同步 L1 + 异步写穿 L2**）：

```ts
// vite.config.ts
import { createIsrPlugin, RedisCacheAdapter, createHybridCacheStore } from '@novel-isr/engine';

const redisAdapter = new RedisCacheAdapter({
  host: process.env.REDIS_HOST!,
  port: 6379,
  keyPrefix: 'isr:',
});

export default defineConfig({
  plugins: [
    ...createIsrPlugin({
      isrCache: {
        store: createHybridCacheStore({
          redis: redisAdapter,
          max: 5000,
          redisKeyPrefix: 'resp:',
          onRedisError: (err, op, key) => Sentry.captureException(err, { tags: { op, key } }),
        }),
      },
    }),
  ],
});
```

### 行为细节

- **读路径**：纯 L1 同步（< 1ms 命中），不引入 Redis 网络延迟
- **L1 miss**：请求级 async 回源 L2，并回填本地 L1
- **写路径**：同步 L1 + fire-and-forget 写 L2（不阻塞响应）
- **L2 失败**：`onRedisError` 回调上报，L1 行为不受影响
- **`revalidateTag` / `revalidatePath`**：同步清 L1，异步清 L2（最终一致）

### Cross-pod invalidation

`revalidate.ts` 用 `Symbol.for(globalThis)` 注册本进程 invalidator；生产启动器在检测到
`REDIS_URL` / `REDIS_HOST` 或 `defineSiteHooks({ redis })` 时，会额外启用 Redis Pub/Sub
失效广播：

- 当前 pod 先清本地 L1，再 publish `{ kind, value }`
- 其他 pod 收到消息后只清自己的 L1，不会再次 publish，避免广播风暴
- L2 Redis 仍由 `createHybridCacheStore` 的 delete / tag 逻辑维护，整体是最终一致

最小配置：

```ts
// src/entry.server.tsx
import { defineSiteHooks } from '@novel-isr/engine/server-entry';

export default defineSiteHooks({
  redis: {
    url: process.env.REDIS_URL,
    keyPrefix: 'isr:',
    // 可选；默认 `${keyPrefix}invalidate`
    invalidationChannel: 'isr:invalidate',
  },
});
```

注意：Pub/Sub 不是持久化队列。Redis 短暂不可用或 pod 断线期间的失效事件可能丢失，
因此企业部署仍建议保留较短 L1 TTL、监控 `isr_invalidator_failures_total`，并在高一致性
业务中使用消息队列或控制面重放作为补偿。

## 推荐：每 pod 暖热 30s 后 L1 命中率 > 95%，L2 主要承担冷启动 + 跨 pod 一致性。

## 失败语义（v2.0.x 起）

`revalidateTag` / `revalidatePath` 用 `Promise.allSettled` 串起所有 invalidator——
任一失败不会中断其他 invalidator 跑完。整体结果：

- **全部成功** → resolve void
- **任一失败** → reject `RevalidationError`（含 `successCount` / `failureCount` /
  `causes: Error[]` / `target: 'tag:books' | 'path:/foo'`）
- 每个失败都会单独 log + 递增 `isr_invalidator_failures_total{kind}` Prometheus
  counter，方便告警

### 不 catch 的默认行为

异常向上传播给调用方（Server Action → React → Client）。React 19 会把 Server Action
错误转给客户端调用点。这是**安全的默认值**——你看得见失败，不会出现"看似成功
但缓存没清"的脏状态。

### 想要静默体验时

如果偶尔的 invalidator 抖动（Redis 超时之类）不应该打扰用户，在 Server Action 里包：

```ts
'use server';
import { revalidateTag, RevalidationError } from '@novel-isr/engine/rsc';

export async function publishBook() {
  // ... write db
  try {
    await revalidateTag('books');
  } catch (err) {
    if (err instanceof RevalidationError) {
      console.error(
        `[publishBook] ${err.successCount}/${err.successCount + err.failureCount} ok:`,
        err.causes.map(e => e.message).join('; ')
      );
      return; // 失败也算成功，下次 TTL 自然过期会自愈
    }
    throw err;
  }
}
```

参考实现：[`novel-rating-website/src/actions/books.ts`](../../novel-rating-website/src/actions/books.ts)。

### 路线图

更强保障（retry + dead letter queue + Redis Pub/Sub 断线补偿）见
[`production-readiness.md` P1 路线图](./production-readiness.md)。

## 缓存可观测性

| 端点 | 内容 |
|---|---|
| `/__isr/stats` | JSON `{ size, max, revalidating }` |
| `/__isr/clear` | POST 清空缓存（dev 默认开，prod 默认关） |
| `/metrics` | Prometheus：`isr_cache_entries{backend}` / `isr_cache_hits_total{status}` 等 |

dev 模式默认全开。生产模式 `/__isr/stats` 和 `/__isr/clear` 默认不注册；显式开启时建议配 `server.admin.authToken`。
