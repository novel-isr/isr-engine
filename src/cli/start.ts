/** Production CLI: config, listener and process lifecycle around the shared runtime. */
import { loadConfig } from '../config/loadConfig';
import { logger } from '@/logger';
import { DEFAULT_PORT } from '@/config/defaults';
import { startServer, closeServer } from '@/server/httpServer';
import { createProductionRuntime, prepareProductionBuild } from '@/server/productionRuntime';
export {
  extractRoutesForSitemap,
  applyTelemetryIntegrationEnv,
  createProductionJsonMiddleware,
  nodeToWebRequest,
  pipeWebResponse,
  createStaticHtmlMiddleware,
  createStaticAssetMiddleware,
} from '@/server/productionRuntime';

interface StartOptions {
  port?: string;
  host?: string;
}
export async function startProductionServer(options: StartOptions): Promise<void> {
  process.env.NODE_ENV = 'production';
  let build;
  try {
    build = await prepareProductionBuild();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    logger.error('[CLI]', '未找到生产构建产物，请先运行 pnpm build');
    process.exit(1);
  }
  const config = await loadConfig();
  if (options.port) config.server.port = parseInt(options.port, 10);
  if (options.host) config.server.host = options.host;
  const runtime = await createProductionRuntime(config, { build });
  let result;
  try {
    result = await startServer(runtime.app, {
      port: config.server?.port ?? DEFAULT_PORT,
      host: config.server?.host,
      strictPort: config.server?.strictPort,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  logger.success('[CLI]', `生产服务器已启动: ${result.url}`);
  let shuttingDown = false;
  const handleShutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    logger.warn('[CLI]', `收到 ${signal}，关闭生产服务器...`);
    const forceExit = setTimeout(() => process.exit(1), 3000);
    forceExit.unref();
    const cleanups = await Promise.allSettled([closeServer(result.server), runtime.close()]);
    clearTimeout(forceExit);
    process.exit(cleanups.some(result => result.status === 'rejected') ? 1 : 0);
  };
  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
}
