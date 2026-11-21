/**
 * 缓存失效契约 —— `revalidatePath(path)` 按路径精准失效；`revalidateTag(tag)` 按渲染期声明的 tag 失效
 *
 * 跨环境状态共享：
 *   Server Action 在 Vite 的 `rsc` 环境中执行（模块图 A），
 *   而 ISR 缓存中间件注册 invalidator 在 Node 上下文（模块图 B），
 *   两份模块图下，同名模块可能各自持有独立的 ES 模块状态。
 *   因此本模块把 invalidator 注册表挂在 `globalThis` 上作为跨环境单例，
 *   确保 `revalidatePath/Tag` 调用能分发到所有已注册的 invalidator。
 *
 * 失败语义（v2.0.x 起）：
 *   过去版本用 `Promise.all`，**首个失败的 invalidator 会抛出，剩余的可能仍在执行
 *   但 reject 被吞**——多 invalidator 场景下出现"看似成功但部分缓存没清"的脏状态。
 *   现在改为：
 *     1. `Promise.allSettled` 让所有 invalidator 都跑到底
 *     2. 每个失败单独打 metric + log（含 trace 上下文）
 *     3. 整体 ≥ 1 个失败 → 抛聚合 `RevalidationError`（含 successCount/failureCount/causes）
 *   调用方（Server Action）务必 `try { await revalidateTag(...) } catch (e) { ... }`，
 *   否则用户提交后看到的是 200 但底层有部分 cache 未清——这种"沉默错误"比抛错更危险。
 *
 * 用法：
 *   1. Server Action 内部调用 `revalidatePath('/books')` 或 `revalidateTag('books')`
 *   2. ISR cache 中间件 / ISREngine 启动时通过 `registerInvalidator(fn)` 注册
 *   3. 分发到所有注册的 invalidator，清理对应缓存条目
 *
 * 注意：
 *   - 本模块不持有任何缓存实现，纯做路由分发
 *   - revalidatePath 与 revalidateTag 在无注册时保留 no-op；发布要求活跃的引擎运行时
 */

import { randomUUID } from 'node:crypto';
import { runtimeLogger as logger } from '../logger/runtimeLogger';
import {
  invalidateContentCaches,
  normalizeContentScopes,
  type ContentPublication,
  type ContentRevalidationOptions,
} from '../defaults/runtime/contentRevalidation';
import { recordRevalidationMetric } from './revalidationMetrics';
import { withLocale, type I18nConfig } from '../runtime/i18n';
import { htmlRouteIdentity } from '../utils/htmlPathname';

/** Invalidator 签名：接收失效目标描述 */
export interface RevalidateInvalidator {
  (target: RevalidateTarget): Promise<void> | void;
}

type ContentResponseInvalidator = (publication: ContentPublication) => Promise<void> | void;

/** 全局单例 key（Symbol.for 保证跨模块图复用同一注册表） */
const REGISTRY_KEY = Symbol.for('isr-engine:revalidate-registry');
type Registry = Map<
  RevalidateInvalidator,
  { publish: ContentResponseInvalidator; i18n?: I18nConfig } | undefined
>;

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Registry;
};

function getRegistry(): Registry {
  const g = globalThis as GlobalWithRegistry;
  return (g[REGISTRY_KEY] ??= new Map());
}

/**
 * 注册一个 invalidator 实例（通常由 ISR 缓存中间件 / ISREngine 调用）
 * 返回取消注册的函数
 */
export function registerInvalidator(
  fn: RevalidateInvalidator,
  invalidatePublication?: ContentResponseInvalidator,
  i18n?: I18nConfig
): () => void {
  const registry = getRegistry();
  registry.set(fn, invalidatePublication && { publish: invalidatePublication, i18n });
  return () => {
    registry.delete(fn);
  };
}

/**
 * 聚合失效错误 —— 当一个或多个 invalidator 失败时抛出。
 *
 * 含：
 *   - successCount / failureCount：方便调用方决定补偿策略
 *   - causes：每个失败的原始 Error（按注册顺序）
 *   - target：触发本次 revalidate 的描述（'tag:books' / 'path:/books'）
 *
 * 注意：用 `extends Error` 而非 `AggregateError`，因为 AggregateError 在某些 Node
 * 版本对 stack/message 序列化不稳，自定义 class 更可控且 instanceof 检测可靠。
 */
export class RevalidationError extends Error {
  public readonly target: string;
  public readonly successCount: number;
  public readonly failureCount: number;
  public readonly causes: readonly Error[];

  constructor(
    target: string,
    successCount: number,
    failureCount: number,
    causes: readonly Error[]
  ) {
    super(
      `revalidate(${target}) —— ${failureCount} invalidator(s) failed, ` +
        `${successCount} succeeded. First cause: ${causes[0]?.message ?? '(unknown)'}`
    );
    this.name = 'RevalidationError';
    this.target = target;
    this.successCount = successCount;
    this.failureCount = failureCount;
    this.causes = causes;
  }
}

export type RevalidateTarget = { kind: 'path'; value: string } | { kind: 'tag'; value: string };

export function contentResponseTargets(scopes: ContentPublication['scopes']): RevalidateTarget[] {
  return [
    ...scopes.paths.map(value => ({ kind: 'path' as const, value })),
    ...scopes.tags.map(value => ({ kind: 'tag' as const, value })),
  ];
}

/**
 * 内部统一分发：跑所有 invalidator，把失败聚合成 RevalidationError 抛出。
 *
 * `Promise.allSettled` 保证任意 invalidator 抛错都不会中断其他 invalidator 的执行——
 * 这样即使 Redis 回源失败，进程内 LRU 至少能清干净；进程内 LRU 失败也不会拖累 Redis。
 */
async function dispatch(target: RevalidateTarget): Promise<void> {
  const targetLabel = `${target.kind}:${target.value}`;
  await runInvalidators(
    targetLabel,
    Array.from(getRegistry().keys(), invalidate => () => invalidate(target)),
    target
  );
}

async function runInvalidators(
  targetLabel: string,
  invalidators: Array<() => Promise<void> | void>,
  target?: RevalidateTarget
): Promise<void> {
  if (invalidators.length === 0) {
    logger.debug(`revalidate(${targetLabel}) —— 无 invalidator 注册，忽略`);
    return;
  }

  if (target) recordRevalidationMetric('run', target.kind, target.value);

  // 包一层 async 函数：把同步抛错也转成 Promise rejection，让 allSettled 能统一处理
  // （直接 `fn(target)` 在 fn 同步抛错时会在 `.map` 里 escape，allSettled 收不到）
  const results = await Promise.allSettled(invalidators.map(async fn => fn()));

  const causes: Error[] = [];
  let successCount = 0;
  let failureCount = 0;

  results.forEach((r, idx) => {
    if (r.status === 'fulfilled') {
      successCount++;
      return;
    }
    failureCount++;
    const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
    causes.push(err);
    if (target) recordRevalidationMetric('failure', target.kind, target.value);
    // 单独 log 每个失败，方便从 stack 定位是哪个 invalidator
    logger.error(`[revalidate] invalidator #${idx} failed for ${targetLabel}: ${err.message}`, err);
  });

  if (failureCount > 0) {
    throw new RevalidationError(targetLabel, successCount, failureCount, causes);
  }

  logger.debug(
    `✅ revalidate(${targetLabel}) —— 已分发到 ${invalidators.length} 个 invalidator（全部成功）`
  );
}

/**
 * 使指定路径的缓存失效
 *
 * @param path 形如 '/books' / '/posts/42' 的路径
 * @throws {RevalidationError} 任意 invalidator 失败时（其余仍执行完毕）
 */
export async function revalidatePath(path: string): Promise<void> {
  await dispatch({ kind: 'path', value: path });
}

/**
 * 使指定 tag 标记的所有缓存条目失效
 *
 * @param tag 业务语义 tag（如 'books' / `book:${id}`）
 * @throws {RevalidationError} 任意 invalidator 失败时（其余仍执行完毕）
 */
export async function revalidateTag(tag: string): Promise<void> {
  await dispatch({ kind: 'tag', value: tag });
}

/** Invalidate managed metadata before invalidating the affected rendered responses. */
export async function revalidateContent(options: ContentRevalidationOptions): Promise<void> {
  const { localizedPaths = [], ...scopes } = normalizeContentScopes(options);
  const targets = contentResponseTargets(scopes);
  if (!targets.length && !localizedPaths.length && !scopes.locales.length && !scopes.sitemap) {
    throw new TypeError('Content revalidation requires at least one scope');
  }
  if (localizedPaths.length && !scopes.locales.length) {
    throw new TypeError('localizedPaths requires locales');
  }
  const registry = Array.from(getRegistry());
  if (
    !registry.length ||
    ((localizedPaths.length || scopes.locales.length || scopes.sitemap) &&
      !registry.some(([, handler]) => handler))
  ) {
    throw new Error(
      'revalidateContent requires an active ISR runtime. Deliver the publication to the site runtime.'
    );
  }
  const id = randomUUID();
  const invalidators = registry.flatMap(([invalidate, handler]) => {
    if (!handler) return targets.map(target => () => invalidate(target));
    const paths = localizedPaths.length
      ? [
          ...new Set([
            ...scopes.paths,
            ...expandLocalizedPaths(localizedPaths, scopes.locales, handler.i18n),
          ]),
        ]
      : scopes.paths;
    return [() => handler.publish({ id, scopes: { ...scopes, paths } })];
  });
  // Resolve every target before changing local metadata or shared caches.
  invalidateContentCaches(scopes);
  await runInvalidators('content', invalidators);
}

function expandLocalizedPaths(
  paths: readonly string[],
  locales: readonly string[],
  i18n?: I18nConfig
): string[] {
  if (!i18n) throw new TypeError('localizedPaths requires runtime.i18n configuration');
  const configured = new Map(i18n.locales.map(locale => [locale.toLowerCase(), locale]));
  const requested = locales.map(locale => {
    const match = configured.get(locale);
    if (!match) throw new TypeError('Unknown publication locale');
    return match;
  });
  return paths.flatMap(path => {
    let identity: string;
    try {
      identity = htmlRouteIdentity(path);
    } catch {
      throw new TypeError(
        'localizedPaths requires origin-relative pathnames without queries or fragments'
      );
    }
    if (configured.has(identity.split('/')[1]?.toLowerCase() ?? '')) {
      throw new TypeError('Use paths for page paths that already contain a locale prefix');
    }
    return requested.map(locale => withLocale(path, locale, i18n));
  });
}

export { registerContentInvalidator } from '../defaults/runtime/contentRevalidation';
export type { ContentRevalidationOptions } from '../defaults/runtime/contentRevalidation';
