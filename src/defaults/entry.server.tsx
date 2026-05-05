/**
 * 服务端入口（engine 内置 wrapper，**永远是** plugin-rsc 的 rsc env 入口）
 *
 * 自动按形状分派 —— 用户 src/entry.server.tsx 可以是任一形状：
 *
 *   形状 A · FaaS 配置（推荐 99% 场景）：
 *     export default {
 *       beforeRequest: (req) => ({ traceId: crypto.randomUUID() }),
 *       onResponse: (res, ctx) => res.headers.set('x-trace-id', ctx.traceId),
 *       onError: (err, req) => console.error(err),
 *     };
 *
 *   形状 B · 完整 fetch handler（用户接管全部协议）：
 *     export default { fetch: async (req) => new Response(...) };
 *
 *   形状 C · 不写 src/entry.server.tsx（engine 默认空 hooks）—— 不需要任何代码
 *
 * wrapper 在加载用户 default export 后做形状嗅探：
 *   有 .fetch 方法           → 直接当 handler 用
 *   否则当 hooks 配置        → 用 defineServerEntry 包一层
 */
import { defineServerEntry, type ServerEntryHooks } from './runtime/defineServerEntry';
import { applyRuntimeToServerHooks } from './runtime/defineSiteHooks';
import { createAutoServerHooks } from './auto-observability';
// @ts-expect-error - @app/_server-config 由 createIsrPlugin 注入：
//   - 用户提供 src/entry.server.tsx 时 → 解析到该文件
//   - 用户没提供时              → 解析到 engine 内置 empty-config（默认 {}）
import userConfig from '@app/_server-config';
// @ts-expect-error - virtual:novel-isr/runtime-config 由 createIsrPlugin 注入 ssr.config.ts runtime
import runtimeConfig from 'virtual:novel-isr/runtime-config';

interface FetchHandlerLike {
  fetch: (request: Request) => Promise<Response>;
}

function hasFetchHandler(x: unknown): x is FetchHandlerLike {
  return !!x && typeof (x as FetchHandlerLike).fetch === 'function';
}

// env 自动装配 SDK（SENTRY_ENABLED=true + SENTRY_DSN / DD_SERVICE / OTEL_EXPORTER_OTLP_ENDPOINT）
// 在第一次请求前完成；后续请求零开销
const autoHooksPromise = createAutoServerHooks();

const resolved: FetchHandlerLike = hasFetchHandler(userConfig)
  ? userConfig
  : (() => {
      // 先用空 hooks 占位，第一个请求时把 auto + user 合并好的 handler 替换上来
      let realHandler: FetchHandlerLike | null = null;
      let initPromise: Promise<FetchHandlerLike> | null = null;

      return {
        async fetch(request: Request): Promise<Response> {
          if (!realHandler) {
            initPromise ??= (async () => {
              const auto = await autoHooksPromise;
              const user = applyRuntimeToServerHooks(
                (userConfig ?? {}) as ServerEntryHooks,
                runtimeConfig ?? {}
              );
              // 合并顺序：auto 先（SDK 模板），user 覆盖（业务定制赢）
              const merged: ServerEntryHooks = {
                ...auto,
                ...user,
                // beforeRequest / onResponse / onError 链式：先 auto 再 user
                beforeRequest: chainBefore(auto.beforeRequest, user.beforeRequest),
                onResponse: chainResponse(auto.onResponse, user.onResponse),
                onError: chainError(auto.onError, user.onError),
              };
              return defineServerEntry(merged);
            })();
            realHandler = await initPromise;
          }
          return realHandler.fetch(request);
        },
      };
    })();

function chainBefore(
  a: ServerEntryHooks['beforeRequest'],
  b: ServerEntryHooks['beforeRequest']
): ServerEntryHooks['beforeRequest'] {
  if (!a) return b;
  if (!b) return a;
  return async (req, baseline) => {
    const ax = (await a(req, baseline)) ?? {};
    const bx = (await b(req, baseline)) ?? {};
    return { ...ax, ...bx };
  };
}
function chainResponse(
  a: ServerEntryHooks['onResponse'],
  b: ServerEntryHooks['onResponse']
): ServerEntryHooks['onResponse'] {
  if (!a) return b;
  if (!b) return a;
  return async (res, ctx) => {
    await a(res, ctx);
    await b(res, ctx);
  };
}
function chainError(
  a: ServerEntryHooks['onError'],
  b: ServerEntryHooks['onError']
): ServerEntryHooks['onError'] {
  if (!a) return b;
  if (!b) return a;
  return async (err, req, ctx) => {
    await a(err, req, ctx);
    await b(err, req, ctx);
  };
}

export default resolved;

if (import.meta.hot) {
  import.meta.hot.accept();
}
