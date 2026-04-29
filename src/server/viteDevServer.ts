/**
 * Vite 开发服务器管理（plugin-rsc 模式）
 *
 * 职责：
 *   1. 加载用户项目的 vite.config.ts（含 createIsrPlugin() 返回的 RSC/React/Cache 插件）
 *   2. 以 middleware 模式创建 Vite dev server，供 Express 挂载
 *   3. 确保 ssr.noExternal 包含 `@novel-isr/engine` —— 防止子路径解析失败
 */

import net from 'node:net';

import {
  createServer,
  loadConfigFromFile,
  mergeConfig,
  type ViteDevServer,
  type InlineConfig,
} from 'vite';
import { Logger } from '@/logger/Logger';

/** Vite 服务器单例 */
let viteServer: ViteDevServer | null = null;

const DEFAULT_HMR_PORT = 24678;

async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function resolveHmrPort(preferredPort: number): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  return 0;
}

/**
 * 创建 Vite 开发服务器
 */
export async function createViteDevServer(): Promise<ViteDevServer> {
  const logger = Logger.getInstance();

  if (viteServer) {
    return viteServer;
  }

  const projectRoot = process.cwd();

  // 加载用户项目的 vite.config.ts（里面已经通过 createIsrPlugin() 注入了 rsc + react + cache 插件）
  const loadResult = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    undefined,
    projectRoot
  );

  // 引擎强制覆盖的配置
  const userHmr = loadResult?.config?.server?.hmr;
  const hmrDisabled = userHmr === false;
  const userHmrOptions = typeof userHmr === 'object' ? userHmr : {};
  const preferredHmrPort = userHmrOptions.port ?? DEFAULT_HMR_PORT;
  const hmrPort = hmrDisabled ? preferredHmrPort : await resolveHmrPort(preferredHmrPort);
  if (!hmrDisabled && hmrPort !== preferredHmrPort) {
    logger.info(`Vite HMR 端口 ${preferredHmrPort} 已占用，使用 ${hmrPort || '随机端口'}`);
  }

  const engineOverrides: InlineConfig = {
    server: {
      middlewareMode: true,
      hmr: hmrDisabled
        ? false
        : {
            ...userHmrOptions,
            port: hmrPort || undefined,
          },
    },
    appType: 'custom',
  };

  try {
    if (loadResult?.config) {
      const userConfig = loadResult.config;

      // 确保 ssr.noExternal 包含引擎自身（防止 @novel-isr/engine 子路径解析失败）
      const userSsrNoExternal = userConfig.ssr?.noExternal;
      const ssrNoExternal = Array.isArray(userSsrNoExternal)
        ? [...userSsrNoExternal]
        : userSsrNoExternal
          ? [userSsrNoExternal]
          : [];

      if (!ssrNoExternal.includes('@novel-isr/engine')) {
        ssrNoExternal.push('@novel-isr/engine');
      }

      const finalConfig = mergeConfig(userConfig, {
        ...engineOverrides,
        ssr: {
          ...userConfig.ssr,
          noExternal: ssrNoExternal,
        },
      });

      viteServer = await createServer(finalConfig);
    } else {
      // 无 vite.config.ts：消费者应提供，此处仅返回基础 dev server
      logger.warn('未找到 vite.config.ts —— 消费者必须在项目根下提供配置，否则 RSC 不工作');
      viteServer = await createServer({
        ...engineOverrides,
        ssr: { noExternal: ['@novel-isr/engine'] },
      });
    }

    logger.success('✅ Vite 开发服务器已启动');
    return viteServer;
  } catch (error) {
    logger.error('❌ Vite 开发服务器启动失败:', error);
    throw error;
  }
}

export function getViteDevServer(): ViteDevServer | null {
  return viteServer;
}

export async function closeViteDevServer(): Promise<void> {
  if (viteServer) {
    await viteServer.close();
    viteServer = null;
  }
}

/**
 * 通过 Vite SSR 加载模块
 * （engine 内部很少用；主要留给 SSG 爬虫未来可能的 dev-mode 预渲染路径）
 */
export async function ssrLoadModule<T = unknown>(modulePath: string): Promise<T | null> {
  if (!viteServer) {
    return null;
  }

  try {
    return (await viteServer.ssrLoadModule(modulePath)) as T;
  } catch (error) {
    const logger = Logger.getInstance();
    logger.error(`SSR 模块加载失败: ${modulePath}`, error);
    return null;
  }
}
