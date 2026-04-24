/**
 * 缓存 Tag 上下文 —— 支持 Server Component 在渲染期声明 tag，便于后续 revalidateTag 精细失效
 *
 * 协作模型：
 *   1. ISR 缓存中间件在进入 handler 前 `runWithTagStore(() => rscHandler(request))`
 *      —— 给本次请求开一个 AsyncLocalStorage 作用域，内部放 `{ tags: Set<string> }`
 *   2. Server Component 体内任意位置调用 `cacheTag('books', `book:${id}`)`
 *      → 写入当前作用域的 tags Set
 *   3. 响应捕获阶段 `collectTags()` 读出 tag 列表，写入 CachedEntry.tags
 *   4. `revalidateTag('books')` 被 invalidator 接收后，遍历 cache 条目，
 *      命中 tags 列表的精准清除（无副作用污染其他条目）
 *
 * 跨环境状态共享：
 *   Server Component 在 Vite `rsc` 环境执行（模块图 A），
 *   ISR 缓存中间件在 Node（模块图 B）。
 *   ES 模块作用域的 `new AsyncLocalStorage()` 会被双模块图各持有一份副本，
 *   导致 cacheTag 写入的 store 与 collectTags 读取的 store 不互通。
 *   故本模块把 ALS 实例挂在 `globalThis` 上作为跨模块图单例（Symbol.for key）
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Logger } from '../logger/Logger';

const logger = Logger.getInstance();

interface TagStore {
  tags: Set<string>;
  /** 本次渲染过程中是否被显式标记为不可缓存（例如上游 fetch 失败） */
  uncacheable: boolean;
}

const ALS_KEY = Symbol.for('@novel-isr/engine:cache-tag-als');

type GlobalWithALS = typeof globalThis & {
  [ALS_KEY]?: AsyncLocalStorage<TagStore>;
};

function getALS(): AsyncLocalStorage<TagStore> {
  const g = globalThis as GlobalWithALS;
  if (!g[ALS_KEY]) {
    g[ALS_KEY] = new AsyncLocalStorage<TagStore>();
  }
  return g[ALS_KEY];
}

/**
 * 在独立的 tag 作用域中执行 fn —— 通常由 ISR 缓存中间件在每次请求前调用
 *
 * fn 内部以及 fn 启动的任何 async/Promise 链路内，调用 cacheTag(...) 都会
 * 写入本作用域，不会污染父作用域或兄弟请求
 */
export function runWithTagStore<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return getALS().run({ tags: new Set<string>(), uncacheable: false }, fn);
}

/**
 * 在 Server Component / loader 内显式声明本次渲染产物**不应入缓存**。
 * 适用场景：上游接口失败、降级渲染了一段错误提示 UI、命中风控/限流等
 *   —— 渲染结果是 200，但内容会让用户困惑或马上过期，不应被 ISR HIT 反复回放。
 *
 * 调用一次即可；后续 cacheTag(...) 仍可继续调用但不会改变 uncacheable 决定。
 */
export function markUncacheable(): void {
  const store = getALS().getStore();
  if (store) {
    store.uncacheable = true;
  }
}

/** 读取本次渲染是否被标记为不可缓存（ISR 缓存中间件在响应捕获阶段调用） */
export function isUncacheable(): boolean {
  return getALS().getStore()?.uncacheable === true;
}

/**
 * Server Component / server action / server-only util 内声明：
 * 本次渲染/调用产出的缓存条目应关联以下 tag
 *
 * 多次调用会合并 tag；无 tag 作用域（例如脱离缓存中间件时）静默忽略
 */
export function cacheTag(...tags: string[]): void {
  const store = getALS().getStore();
  if (!store) {
    return;
  }
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.length > 0) {
      store.tags.add(tag);
    }
  }
}

/**
 * 读取当前 tag 作用域的 tag 列表（ISR 缓存中间件在响应捕获阶段调用）
 */
export function collectTags(): string[] {
  const store = getALS().getStore();
  return store ? Array.from(store.tags) : [];
}

/**
 * 调试：打印当前 tag store 状态
 */
export function debugTagStore(label = ''): void {
  const store = getALS().getStore();
  logger.debug(
    `[cacheTag] ${label} store=${store ? JSON.stringify(Array.from(store.tags)) : '<none>'}`
  );
}
