/**
 * 类型补全 —— 仅用于 src/defaults/* 的源码（被用户的 plugin-rsc 二次打包，不进 engine dist）
 *
 * 这些 API 只在 plugin-rsc 的 Vite environment 内可用，engine 自己的 lib build
 * 不消费它们；所以放在 defaults/ 子目录的局部 d.ts，而不是污染 engine 顶层 types
 */

/// <reference types="vite/client" />

declare global {
  interface ImportMeta {
    /**
     * @vitejs/plugin-rsc 注入的 RSC 环境跨 environment 调用 API
     * 详见 https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc
     */
    readonly viteRsc: {
      loadModule<T = unknown>(env: 'rsc' | 'ssr' | 'client', name: string): Promise<T>;
      loadBootstrapScriptContent(name: string): Promise<string>;
    };
  }
}

export {};
