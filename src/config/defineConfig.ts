import type { ISRConfig, RuntimeConfig } from '../types';

type ExactTopLevel<T, Shape> = T & Record<Exclude<keyof T, keyof Shape>, never>;
type IsrServerConfig = NonNullable<ISRConfig['server']>;
type IsrOpsConfig = NonNullable<IsrServerConfig['ops']>;
type ExactOps<T> = T extends { ops?: infer Ops }
  ? {
      ops?: ExactTopLevel<NonNullable<Ops>, IsrOpsConfig>;
    }
  : unknown;
type ExactServer<T> = T extends { server?: infer Server }
  ? {
      server?: ExactTopLevel<NonNullable<Server>, IsrServerConfig> & ExactOps<NonNullable<Server>>;
    }
  : unknown;
type ExactIsrConfig<T extends ISRConfig> = ExactTopLevel<T, ISRConfig> & ExactServer<T>;

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
export function defineIsrConfig<const T extends ISRConfig>(config: ExactIsrConfig<T>): T {
  return config;
}

export function defineRuntimeConfig<const T extends RuntimeConfig>(
  runtime: ExactTopLevel<T, RuntimeConfig>
): T {
  return runtime;
}
