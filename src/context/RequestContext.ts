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
