import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@/logger/Logger';

const logger = Logger.getInstance();

/**
 * 缓存清理工具类
 * 负责在开发环境启动时清理统一的缓存目录
 */
export class CacheCleanup {
  private static readonly CACHE_ROOT_DIR = '.isr-hyou';
  private static readonly ISR_CACHE_DIR = '.isr-hyou/isr';
  private static readonly SSR_CACHE_DIR = '.isr-hyou/ssr';
  private static readonly SSG_CACHE_DIR = '.isr-hyou/ssg';

  /**
   * 安全删除缓存根目录
   */
  private static async safeClearCacheRoot(): Promise<void> {
    try {
      const fullPath = path.resolve(process.cwd(), this.CACHE_ROOT_DIR);

      // 安全检查：确保路径包含预期的缓存目录名
      if (!fullPath.includes('.isr-hyou')) {
        logger.warn(`⚠️ 跳过清理可疑路径: ${fullPath}`);
        return;
      }

      if (fs.existsSync(fullPath)) {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        logger.info(`🧹 已清理缓存根目录: ${this.CACHE_ROOT_DIR}`);
      }
    } catch (error) {
      logger.error('❌ 清理缓存根目录失败:', error);
    }
  }

  /**
   * 开发环境启动时清理缓存
   * 只在开发环境（pnpm dev）时执行，生产环境不处理
   */
  public static async cleanupOnDevStart(): Promise<void> {
    // 生产环境不处理缓存
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    logger.info('🚀 开发环境启动，清理缓存目录...');
    await this.safeClearCacheRoot();
    logger.info('✅ 开发环境缓存清理完成');
  }

  /**
   * 获取ISR缓存目录路径
   */
  public static getISRCacheDir(): string {
    return path.resolve(process.cwd(), this.ISR_CACHE_DIR);
  }

  /**
   * 获取SSR缓存目录路径
   */
  public static getSSRCacheDir(): string {
    return path.resolve(process.cwd(), this.SSR_CACHE_DIR);
  }

  /**
   * 获取SSG缓存目录路径
   */
  public static getSSGCacheDir(): string {
    return path.resolve(process.cwd(), this.SSG_CACHE_DIR);
  }
}
