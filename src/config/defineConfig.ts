import type { ISRConfig, RuntimeConfig } from '../types';

/**
 * ssr.config.ts 的类型收口入口。
 *
 * 业务侧只需要：
 *   export default defineIsrConfig({ ... })
 *
 * 不需要维护 `satisfies ISRConfig` 或 `satisfies NonNullable<ISRConfig['runtime']>`
 * 这种类型技巧。配置形状由 engine API 统一承接，后续字段演进也只改 engine。
 */
export function defineIsrConfig<const T extends ISRConfig>(config: T): T {
  return config;
}

export function defineRuntimeConfig<const T extends RuntimeConfig>(runtime: T): T {
  return runtime;
}
