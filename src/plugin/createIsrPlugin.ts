/**
 * ISR 插件工厂 —— 组合 @vitejs/plugin-rsc + ISR 缓存中间件
 *
 * 真·开箱即用：
 *   import { createIsrPlugin } from '@novel-isr/engine';
 *   export default defineConfig({ plugins: [...createIsrPlugin()] });
 *
 * 用户**唯一必需的应用代码**：`<root>/src/root.tsx`
 *   - 必须 export `Root({ url: URL })` —— 即应用根 Server Component
 *
 * 三个 Vite environment 的入口（client / rsc / ssr）engine 全部内置默认实现：
 *   - 用户不写任何入口文件即可跑起来
 *   - 想覆盖任一个，把同名文件放到 `<root>/src/` 即可（约定优于配置）
 *
 * 入口约定（覆盖文件名）：
 *   src/entry.tsx              —— 客户端水合入口（覆盖默认）
 *   src/entry.server.tsx       —— 服务端 RSC handler（覆盖默认）
 *   src/entry.server.ssr.tsx   —— SSR 转 HTML 入口（覆盖默认）
 *
 * 注：不要再额外注册 @vitejs/plugin-react —— @vitejs/plugin-rsc 已为客户端环境
 *     内置了 react-refresh 运行时注入与 JSX 处理；重复注册会触发
 *     `Identifier 'RefreshRuntime' has already been declared` 错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PluginOption, Plugin } from 'vite';
import vitePluginRsc from '@vitejs/plugin-rsc';

import { createDevAssetRequestMiddleware } from './devAssetRequestMiddleware';
import { createIsrCacheMiddleware } from './isrCacheMiddleware';
import { createSsgPostBuildPlugin } from './createSsgPostBuildPlugin';
import { Logger } from '../logger/Logger';
import type { ISRConfig } from '../types';

const logger = Logger.getInstance();

const VIRTUAL_ENTRY_IDS = {
  client: 'virtual:novel-isr/client-entry',
  rsc: 'virtual:novel-isr/rsc-entry',
  runtime: 'virtual:novel-isr/runtime-config',
} as const;

const RESOLVED_VIRTUAL_PREFIX = '\0';

export interface CreateIsrPluginOptions {
  /** 显式传入 ssr.config —— 未传则缓存中间件内异步自动 loadConfig() */
  config?: Partial<ISRConfig>;
  /** 项目根目录，默认 `process.cwd()` */
  root?: string;
  /** RSC 插件选项透传（不含 entries —— entries 由 engine 按约定自动解析） */
  rsc?: Omit<NonNullable<Parameters<typeof vitePluginRsc>[0]>, 'entries'>;
  /** ISR 缓存选项 */
  isrCache?: {
    max?: number;
    defaultTtlSeconds?: number;
    enabled?: boolean;
  };
}

/**
 * 三个 environment 的入口文件名约定 —— 用户在 src/ 下放同名文件即覆盖
 * engine 默认实现
 */
const ENTRY_CONVENTION = {
  client: 'src/entry.tsx',
  rsc: 'src/entry.server.tsx',
  ssr: 'src/entry.server.ssr.tsx',
} as const;

/** engine 内置默认入口文件名（位于 isr-engine/src/defaults/）*/
const ENGINE_DEFAULTS = {
  client: 'entry.tsx',
  rsc: 'entry.server.tsx',
  ssr: 'entry.server.ssr.tsx',
} as const;

interface ResolvedEntries {
  client: string;
  rsc: string;
  ssr: string;
  source: Record<'client' | 'rsc' | 'ssr', 'user' | 'engine'>;
}

/** 解析 engine defaults 目录的绝对路径（兼容构建产物 dist/ 与源码） */
function resolveEngineDefaultsDir(): string {
  const here =
    typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  // 构建后位于 dist/，源文件在 ../src/defaults
  // 源码场景（test / 直接 ts-node）位于 src/plugin/，源文件在 ../defaults
  const candidates = [
    path.resolve(here, '../src/defaults'),
    path.resolve(here, '../defaults'),
    path.resolve(here, './defaults'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `[@novel-isr/engine] 找不到 engine defaults 目录（候选：${candidates.join(' / ')}）`
  );
}

/**
 * Entry 解析策略：
 *   - client / rsc：永远指向 engine 内置 wrapper；
 *     用户的可选 src/entry.tsx / src/entry.server.tsx 通过 @app/_*-config 别名
 *     注入到 wrapper，wrapper 按形状分派（FaaS hooks 或完整 fetch handler）
 *   - ssr：用户提供 src/entry.server.ssr.tsx 时直接用，否则 engine 默认（极少需要覆盖）
 *
 * 用户唯一必须提供的应用代码：`<root>/src/app.tsx`（导出 App({url})）
 */
function resolveEntries(root: string): ResolvedEntries {
  const defaultsDir = resolveEngineDefaultsDir();

  const wrapperPath = (file: string) => {
    const abs = path.resolve(defaultsDir, file);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `[@novel-isr/engine] engine 内置 wrapper 缺失：${abs}（请检查 engine 安装是否完整）`
      );
    }
    return abs;
  };

  // 应用根 —— 唯一要求用户提供的文件
  const appPath = path.resolve(root, 'src/app.tsx');
  if (!fs.existsSync(appPath)) {
    throw new Error(
      `[@novel-isr/engine] 找不到应用根组件 src/app.tsx，这是 engine 唯一要求的用户文件。\n` +
        `请创建 ${appPath} 并 export function App({ url }: { url: URL }) {...}`
    );
  }

  const hasUserConfig = (env: 'client' | 'rsc' | 'ssr') =>
    fs.existsSync(path.resolve(root, ENTRY_CONVENTION[env]));

  // SSR 入口特殊处理：用户提供时直接用，否则用 engine 默认
  const userSsr = path.resolve(root, ENTRY_CONVENTION.ssr);
  const ssrEntry = fs.existsSync(userSsr) ? userSsr : wrapperPath(ENGINE_DEFAULTS.ssr);

  return {
    client: wrapperPath(ENGINE_DEFAULTS.client),
    rsc: wrapperPath(ENGINE_DEFAULTS.rsc),
    ssr: ssrEntry,
    source: {
      client: hasUserConfig('client') ? 'user' : 'engine',
      rsc: hasUserConfig('rsc') ? 'user' : 'engine',
      ssr: hasUserConfig('ssr') ? 'user' : 'engine',
    },
  };
}

/**
 * 注入两件事：
 *   1. `@app/*` Vite alias
 *      - `@app/_entry` 特殊指向用户的应用根组件文件（app.tsx 优先 / root.tsx 兼容）
 *      - `@app/<x>`    通用指向 `<root>/src/<x>` —— 给用户自定义文件用
 *
 *   2. resolve.dedupe react / react-dom —— engine 默认入口被 plugin-rsc bundle 时，
 *      可能从 engine 的 node_modules 解析 react，导致用户项目里出现两份 React 实例，
 *      水合失败（Cannot read properties of null (reading 'useState')）。
 *      强制 dedupe 让 react 始终从用户项目根解析
 */
/**
 * 给 client environment 注入 process.* 兜底
 *
 * 原因：CJS 库（chalk / signal-exit / supports-color 等）一旦被打包进 client bundle
 * 会在浏览器报 ReferenceError: process is not defined。
 * 哪怕这些库是死代码（CSR fallback 路径不实际执行），rolldown 仍会保留它们的 top-level
 * statement，所以浏览器加载即崩。
 *
 * 兜底：仅对 client environment 注入 vite define，把 `process.platform` / `process.env`
 * 替换为浏览器友好的常量，避免 ReferenceError；不影响 server / rsc / ssr 环境的真实 Node 行为。
 */
function createBrowserShimPlugin(): Plugin {
  return {
    name: 'isr:browser-process-shim',
    config(_, { command }) {
      if (command !== 'build') return; // dev 模式 vite 自己处理 process.env
      // 把可能在 client bundle 顶层访问的 Node 全局，全部静态替换为浏览器友好常量
      const stdMock = '({isTTY:false,write:()=>{},end:()=>{},on:()=>{},getColorDepth:()=>1})';
      return {
        define: {
          'process.platform': '"browser"',
          'process.arch': '"unknown"',
          'process.versions': '({})',
          'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
          'process.stdout': stdMock,
          'process.stderr': stdMock,
          'process.argv': '[]',
        },
      };
    },
  };
}

function createReactVirtualModuleInteropPlugin(): Plugin {
  return {
    name: 'isr:react-virtual-module-interop',
    enforce: 'post',
    transform(code, id) {
      if (!id.includes('vite-rsc/remove-duplicate-server-css')) return null;
      if (!code.includes('import React from "react";')) return null;
      return code.replace('import React from "react";', 'import * as React from "react";');
    },
  };
}

function createEngineDefaultEntriesPlugin(root: string): Plugin {
  const virtualEntryIds = new Set<string>(Object.values(VIRTUAL_ENTRY_IDS));
  const resolvedVirtualEntryIds = new Set<string>(
    Object.values(VIRTUAL_ENTRY_IDS).map(id => `${RESOLVED_VIRTUAL_PREFIX}${id}`)
  );
  const defaultsDir = resolveEngineDefaultsDir();
  const fileImport = (relativePath: string) =>
    JSON.stringify(pathToFileURL(path.resolve(defaultsDir, relativePath)).href);

  return {
    name: 'isr:engine-default-entries',
    enforce: 'pre',
    resolveId(id) {
      if (resolvedVirtualEntryIds.has(id)) {
        return id;
      }
      if (virtualEntryIds.has(id)) {
        return `${RESOLVED_VIRTUAL_PREFIX}${id}`;
      }
      return null;
    },
    load(id) {
      if (id === `${RESOLVED_VIRTUAL_PREFIX}${VIRTUAL_ENTRY_IDS.client}`) {
        // 客户端入口仍以源码形式注入 plugin-rsc 的 client 环境 ——
        // defineClientEntry 依赖 `@vitejs/plugin-rsc/browser`（虚拟模块
        // virtual:vite-rsc/client-references），只能在消费方 plugin-rsc 构建
        // 上下文里二次打包。靠 createIsrPlugin 注入 optimizeDeps.include 让
        // 消费方 Vite scanner 把 React 等依赖纳入 pre-bundle。
        return `
          import { defineClientEntry } from ${fileImport('runtime/defineClientEntry.tsx')};
          import userConfig from '@app/_client-config';

          defineClientEntry((userConfig ?? {}));
        `;
      }

      if (id === `${RESOLVED_VIRTUAL_PREFIX}${VIRTUAL_ENTRY_IDS.rsc}`) {
        // RSC 入口仍以源码形式注入 plugin-rsc 的 RSC 环境 ——
        // defineServerEntry 依赖 `@vitejs/plugin-rsc/rsc`，必须在 plugin-rsc
        // 的构建上下文里二次打包，不能预先 bundle 成普通 JS。
        return `
          import { defineServerEntry } from ${fileImport('runtime/defineServerEntry.tsx')};
          import { applyRuntimeToServerHooks } from ${fileImport('runtime/defineSiteHooks.ts')};
          import { createAutoServerHooks } from '@novel-isr/engine/auto-observability';
          import userConfig from '@app/_server-config';
          import runtimeConfig from '${VIRTUAL_ENTRY_IDS.runtime}';

          function hasFetchHandler(x) {
            return !!x && typeof x.fetch === 'function';
          }

          const autoHooksPromise = createAutoServerHooks();

          const resolved = hasFetchHandler(userConfig)
            ? userConfig
            : (() => {
                let realHandler = null;
                let initPromise = null;

                return {
                  async fetch(request) {
                    if (!realHandler) {
                      initPromise ??= (async () => {
                        const auto = await autoHooksPromise;
                        const user = applyRuntimeToServerHooks(userConfig ?? {}, runtimeConfig ?? {});
                        const merged = {
                          ...auto,
                          ...user,
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

          function chainBefore(a, b) {
            if (!a) return b;
            if (!b) return a;
            return async (req, baseline) => {
              const ax = (await a(req, baseline)) ?? {};
              const bx = (await b(req, baseline)) ?? {};
              return { ...ax, ...bx };
            };
          }

          function chainResponse(a, b) {
            if (!a) return b;
            if (!b) return a;
            return async (res, ctx) => {
              await a(res, ctx);
              await b(res, ctx);
            };
          }

          function chainError(a, b) {
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
        `;
      }

      if (id === `${RESOLVED_VIRTUAL_PREFIX}${VIRTUAL_ENTRY_IDS.runtime}`) {
        const configPath = path.resolve(root, 'ssr.config.ts');
        if (!fs.existsSync(configPath)) {
          return `export default {};`;
        }
        return `
          const configModule = await import(${JSON.stringify(pathToFileURL(configPath).href)});
          const defaultConfig = configModule.default ?? {};
          const namedRuntime = configModule['runtime'];
          export default defaultConfig.runtime ?? namedRuntime ?? {};
        `;
      }

      return null;
    },
  };
}

function createAppAliasPlugin(root: string): Plugin {
  const userSrc = path.resolve(root, 'src');
  const defaultsDir = resolveEngineDefaultsDir();
  const emptyConfig = path.resolve(defaultsDir, 'runtime/empty-config.ts');
  const emptyRoutes = path.resolve(defaultsDir, 'runtime/empty-routes.ts');

  const appEntry = path.resolve(userSrc, 'app.tsx');
  const appRoutes = path.resolve(userSrc, 'routes.tsx');

  const userOrEmpty = (rel: string) => {
    const abs = path.resolve(root, rel);
    return fs.existsSync(abs) ? abs : emptyConfig;
  };

  return {
    name: 'isr:app-alias',
    enforce: 'pre',
    config() {
      // 精确匹配优先于通用 @app/* 模式
      const aliases: Array<{ find: string | RegExp; replacement: string }> = [
        { find: '@app/_entry', replacement: appEntry },
        { find: '@app/_routes', replacement: fs.existsSync(appRoutes) ? appRoutes : emptyRoutes },
        { find: '@app/_client-config', replacement: userOrEmpty(ENTRY_CONVENTION.client) },
        { find: '@app/_server-config', replacement: userOrEmpty(ENTRY_CONVENTION.rsc) },
        { find: '@app/_ssr-config', replacement: userOrEmpty(ENTRY_CONVENTION.ssr) },
        { find: /^@app\/(.*)$/, replacement: `${userSrc}/$1` },
      ];

      return {
        resolve: {
          alias: aliases,
          dedupe: ['react', 'react-dom', 'react-server-dom-webpack', 'rsc-html-stream'],
        },
        // engine 把 client/rsc 入口指向虚拟模块 → 再 alias 到 engine 源 .tsx 文件，
        // 不在用户 node_modules 树里。Vite 的 optimizeDeps scanner 默认不跟 file:// URL
        // 进入 React 等 CJS 依赖，导致浏览器侧加载到原始 CJS 报
        // "does not provide an export named 'default'/'jsxDEV'"。
        // 显式声明这些依赖必须 pre-bundle，业务侧零配置。
        optimizeDeps: {
          // RSC dev 没有传统 index.html 入口；显式扫描业务 src，避免首屏才发现
          // client package proxy 依赖并触发动态 import 竞态。
          entries: ['src/**/*.{js,jsx,ts,tsx}'],
          include: [
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-dom',
            'react-dom/client',
          ],
          exclude: [
            '@novel-isr/engine',
            '@novel-isr/engine/runtime',
            '@app/_entry',
            '@app/_routes',
            '@app/_client-config',
            '@app/_server-config',
            '@app/_ssr-config',
          ],
        },
      };
    },
  };
}

export function createIsrPlugin(options: CreateIsrPluginOptions = {}): PluginOption[] {
  const {
    config: userConfig = {},
    root = process.cwd(),
    rsc: rscOptions,
    isrCache: isrCacheOptions,
  } = options;

  const entries = resolveEntries(root);

  // 报告用户挂没挂 hooks（client / rsc 永远走 engine wrapper，区别只在用户是否提供了 hooks）
  // SSR 是直接覆盖（用户文件直接当 entry，无 wrapper）
  const fmt = (env: 'client' | 'rsc' | 'ssr') => {
    if (env === 'ssr') {
      return entries.source.ssr === 'user'
        ? `${path.relative(root, entries.ssr)}（用户覆盖）`
        : '<engine 默认>';
    }
    return entries.source[env] === 'user'
      ? `<engine wrapper> + ${ENTRY_CONVENTION[env]}（FaaS hooks 已挂载）`
      : '<engine 默认（无 hooks）>';
  };
  logger.info(`🧭 ISR entries：`);
  logger.info(`   client = ${fmt('client')}`);
  logger.info(`   server = ${fmt('rsc')}`);
  logger.info(`   ssr    = ${fmt('ssr')}`);

  const plugins: PluginOption[] = [
    createEngineDefaultEntriesPlugin(root),
    createAppAliasPlugin(root),
    createDevAssetRequestMiddleware(root),
    createBrowserShimPlugin(),
    createReactVirtualModuleInteropPlugin(),
  ];

  if (isrCacheOptions?.enabled !== false) {
    plugins.push(
      createIsrCacheMiddleware(userConfig, {
        max: isrCacheOptions?.max,
        defaultTtlSeconds: isrCacheOptions?.defaultTtlSeconds,
      })
    );
  }

  plugins.push(
    vitePluginRsc({
      ...rscOptions,
      entries: {
        client: VIRTUAL_ENTRY_IDS.client,
        rsc: VIRTUAL_ENTRY_IDS.rsc,
        ssr: entries.ssr,
      },
    })
  );

  // 让 `vite build` 自动跑 SSG 预渲染，无需 `novel-isr build` CLI 包一层
  plugins.push(createSsgPostBuildPlugin(userConfig as ISRConfig | undefined));

  return plugins;
}
