import { AsyncLocalStorage } from 'async_hooks';
import type { ISRContextData } from '../types/ISRContext';

// 复用 ISRContextData 类型，确保 ALS 中的数据结构与 ISRContext.data 一致
export type RequestContextState = ISRContextData;

// 全局 ALS 实例
export const requestContext = new AsyncLocalStorage<RequestContextState>();

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
