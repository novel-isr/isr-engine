/**
 * 开发服务器命令
 */

import { logger } from '@/logger';
import { createISRApp } from '../app/createISRApp';
import { loadConfig } from '../config/loadConfig';
import { DEFAULT_PORT, DEFAULT_PROTOCOL } from '@/config/defaults';

interface StartOptions {
  port: string;
  host?: string;
}

export async function startDevServer(options: StartOptions) {
  const { port, host } = options;

  logger.info('[CLI]', '启动开发服务器');
  logger.spin('初始化开发环境...');

  try {
    // 读取项目配置
    const config = await loadConfig();

    // 确保 server 配置存在
    config.server = config.server || {
      port: DEFAULT_PORT,
      protocol: DEFAULT_PROTOCOL,
    };

    // CLI 参数覆盖配置
    if (port) {
      config.server.port = parseInt(port);
    }
    if (host) {
      config.server.host = host;
    }

    // 创建应用实例
    const app = await createISRApp(config);

    logger.stopSpinner('开发环境初始化完成');

    // 启动服务器
    const serverContext = await app.start();

    logger.success('[CLI]', '开发服务器已启动');
    if (serverContext.url) {
      logger.info('[Server]', `服务地址: ${serverContext.url}`);
      logger.info('[Server]', `健康检查: ${serverContext.url}/health`);
    } else {
      logger.info('[Server]', `端口: ${config.server.port}`);
      logger.info('[Server]', '健康检查: /health');
    }

    logger.info('[CLI]', '开发提示:');
    logger.info('[CLI]', '- 修改文件将自动重新加载');
    logger.info('[CLI]', '- 使用 Ctrl+C 停止服务器');
    logger.info('[CLI]', '- 查看实时日志和性能指标');

    // 优雅关闭：
    //   - 第一次 Ctrl+C：走 app.shutdown()（关 Vite + 强制断开 HTTP keep-alive 连接 + 释放端口）
    //   - 3 秒内完不成 / 收到第二次信号：强制 process.exit(0)（防僵死）
    let shuttingDown = false;
    const handleShutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        logger.warn('[CLI]', `收到 ${signal} 二次触发 —— 强制退出`);
        process.exit(1);
      }
      shuttingDown = true;
      logger.warn('[CLI]', `收到 ${signal}，关闭服务器...`);

      const forceExit = setTimeout(() => {
        logger.warn('[CLI]', '关闭超时，强制退出');
        process.exit(1);
      }, 3000);
      forceExit.unref();

      try {
        await app.shutdown();
      } catch (err) {
        logger.error('[CLI]', '关闭时发生异常', err);
      }
      clearTimeout(forceExit);
      process.exit(0);
    };
    process.on('SIGINT', () => void handleShutdown('SIGINT'));
    process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  } catch (error) {
    logger.stopSpinner('开发服务器启动失败');
    logger.error('[CLI]', '开发服务器启动失败', error);
    throw error;
  }
}
