import { AsyncLocalStorage } from 'async_hooks';
import type { ISRContextData } from '../types/ISRContext';

// 复用 ISRContextData 类型，确保 ALS 中的数据结构与 ISRContext.data 一致
export type RequestContextState = ISRContextData;

const REQUEST_CONTEXT_KEY = '__NOVEL_ISR_REQUEST_CONTEXT__';

function getGlobalRequestContext(): AsyncLocalStorage<RequestContextState> {
  const globalState = globalThis as typeof globalThis & {
    [REQUEST_CONTEXT_KEY]?: AsyncLocalStorage<RequestContextState>;
  };

  globalState[REQUEST_CONTEXT_KEY] ??= new AsyncLocalStorage<RequestContextState>();
  return globalState[REQUEST_CONTEXT_KEY];
}

// 全局 ALS 实例。dev 下 source/dist 可能同时被 Vite 加载，必须共享同一份请求上下文。
export const requestContext = getGlobalRequestContext();

// 获取当前请求上下文的辅助函数
export const getRequestContext = (): RequestContextState | undefined => {
  return requestContext.getStore();
};

// 获取 Trace ID 的辅助函数 (安全访问)
export const getTraceId = (): string => {
  const store = requestContext.getStore();
  return store?.traceId || 'system';
};

// 获取 Request ID 的辅助函数 (安全访问)
export const getRequestId = (): string => {
  const store = requestContext.getStore();
  return store?.requestId || 'unknown';
};

/**
 * 获取 anonId —— 浏览器 / 设备维度稳定 UUID。
 *
 * engine 入口 createServerRequestContext 已保证 RequestContext 存在时这个字段必有值
 * （cookie 缺失会自动生成）；context 不在时（极少数 dev / unit-test 场景）返回 'system'。
 * 业务侧用法：feature gating、telemetry user 维度聚合、个性化推荐 anchor。
 */
export const getAnonId = (): string => {
  const store = requestContext.getStore();
  return store?.anonId || 'system';
};

/**
 * 获取已登录用户 ID。业务侧 beforeRequest hook 解 session 写入；未登录返回 null。
 * 注意：不要把这里返回的字符串当 anonId 用 —— anonId 跨登录态稳定（一个浏览器永远
 * 同一份），userId 跨设备稳定但匿名期为 null。两者职责不同。
 */
export const getUserId = (): string | null => {
  const store = requestContext.getStore();
  return store?.userId ?? null;
};

/**
 * 获取本次请求生效的全部实验变体 —— `{ 'hero-style': 'bold', ... }`。
 * 由 ABVariantMiddleware 基于 hash(anonId + expKey) 确定性算出，不在 cookie 里持久化。
 * 没接 ABVariantMiddleware 时返回空对象。
 */
export const getExperiments = (): Record<string, string> => {
  const store = requestContext.getStore();
  return store?.experiments ?? {};
};
