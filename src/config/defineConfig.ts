import type { ISRConfig, RuntimeConfig } from '../types';

/**
 * ssr.config.ts 的类型收口入口。
 *
 * 业务侧只需要：
 *   import { defineIsrConfig } from '@novel-isr/engine/config';
 *   export default defineIsrConfig({ ... })
 *
 * 不需要维护 `satisfies ISRConfig` 或 `satisfies NonNullable<ISRConfig['runtime']>`
 * 这种类型技巧。配置形状由 engine API 统一承接，后续字段演进也只改 engine。
 *
 * 注意：ssr.config.ts 应从 @novel-isr/engine/config 导入，避免根入口把 CLI/plugin
 * 工具链打进 RSC/SSG bundle。
 */
export function defineIsrConfig<const T extends ISRConfig>(config: T): T {
  return config;
}

export function defineRuntimeConfig<const T extends RuntimeConfig>(runtime: T): T {
  return runtime;
}
