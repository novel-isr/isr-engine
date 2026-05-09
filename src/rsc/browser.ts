/**
 * Browser stub for @novel-isr/engine/rsc.
 *
 * Server Components may be referenced from a shared route manifest. Client builds must
 * never pull Node-only cache/action infrastructure just because those server modules
 * are statically discoverable. Browser condition resolves here and keeps these APIs
 * inert outside the RSC/server runtime.
 */

export class RevalidationError extends Error {}

export type RevalidateInvalidator = (
  target: { kind: 'path'; value: string } | { kind: 'tag'; value: string }
) => Promise<void> | void;

export function cacheTag(): void {
  void 0;
}

export function markUncacheable(): void {
  void 0;
}

export function collectTags(): string[] {
  return [];
}

export function debugTagStore(): void {
  void 0;
}

export function isUncacheable(): boolean {
  return false;
}

export function runWithTagStore<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return fn();
}

export async function revalidatePath(): Promise<void> {
  await Promise.resolve();
}

export async function revalidateTag(): Promise<void> {
  await Promise.resolve();
}

export function registerInvalidator(): () => void {
  return () => {
    void 0;
  };
}

export const serverActionsRegistry = {
  initialize: async () => Promise.resolve(),
  cleanup: async () => Promise.resolve(),
  register: () => '',
  getAllActions: () => [],
  hasAction: () => false,
  getMetadata: () => undefined,
};

export function createServerAction<T>(handler: T): T {
  return handler;
}

export const ServerActionUtils = {
  isServer: () => false,
  isClient: () => true,
  getExecutionContext: () => ({
    environment: 'client' as const,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    timestamp: new Date().toISOString(),
  }),
};

export const SERVER_ACTION_ENDPOINT = '/_rsc/action';
export const LEGACY_SERVER_ACTION_ENDPOINT = '/api/server-actions';

export function getServerActionEndpointCandidates(primaryEndpoint?: string): string[] {
  return [
    primaryEndpoint || SERVER_ACTION_ENDPOINT,
    SERVER_ACTION_ENDPOINT,
    LEGACY_SERVER_ACTION_ENDPOINT,
  ];
}

export function isLegacyServerActionEndpoint(endpoint: string): boolean {
  return endpoint === LEGACY_SERVER_ACTION_ENDPOINT;
}

export function shouldSkipServerActionEndpointRetry(endpoint: string): boolean {
  return isLegacyServerActionEndpoint(endpoint);
}

export function getVariant(): string | undefined {
  return undefined;
}

// 浏览器/客户端不持有 AsyncLocalStorage 请求上下文 —— 任何业务在 'use client'
// 树里走到 getRequestContext() 都拿 undefined，跟 Server Component 里没有
// 命中作用域时一致。空 stub 让 plugin-rsc 的 client/browser bundle 链不至于
// 因为符号缺失炸开。
export function getRequestContext(): undefined {
  return undefined;
}

export function getI18n(key: string, _params?: Record<string, unknown>, fallback = key): string {
  return fallback;
}

export function getI18nLocale(fallback = ''): string {
  return fallback;
}

export function getCurrentI18n(): null {
  return null;
}

export function runWithI18n<T>(_intl: unknown, fn: () => T): T {
  return fn();
}

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type Translate = (key: string, params?: I18nParams, fallback?: string) => string;
