/**
 * Novel ISR 工厂 - NPM 包入口点
 * 企业级增量静态再生引擎工厂
 */

import { existsSync } from 'fs';
import { Server } from 'http';
import { resolve } from 'path';

import { EnterpriseConfig } from '../config/EnterpriseConfig';
import { RenderModes, NovelISRConfig } from '../types';
import ISREngine from './ISREngine';
import { RouteManager } from '../route';

/**
 * Novel ISR 引擎主类
 * NPM 包的核心 API
 */
export class NovelEngine {
  private userConfig: NovelISRConfig;
  private config: EnterpriseConfig | null = null;
  private isrApp: ISREngine | null = null;
  private server: Server | null = null;
  private routeManager: RouteManager | null = null;

  constructor(userConfig: NovelISRConfig = {}) {
    this.userConfig = userConfig;
  }

  /**
   * 初始化引擎
   */
  public async initialize(): Promise<NovelEngine> {
    console.log('🚀 Novel 引擎初始化中...');

    // 加载用户配置
    await this.loadConfig();

    // 创建路由管理器
    this.routeManager = new RouteManager(this.userConfig);

    // 创建企业级 ISR 配置
    this.config = this.createEnterpriseConfig();

    // 验证配置
    const errors = this.config.validate();
    if (errors.length > 0) {
      throw new Error(`配置错误: ${errors.join(', ')}`);
    }

    console.log('✅ Novel 引擎初始化完成');
    return this;
  }

  /**
   * 加载用户配置 - 企业级简化配置
   */
  async loadConfig() {
    // 查找项目根目录下的配置文件
    const possibleRoots = [
      process.cwd(), // 当前工作目录
      resolve(process.cwd(), '..'), // 父目录
      resolve(process.cwd(), '../..'), // 祖父目录
    ];

    for (const rootDir of possibleRoots) {
      // 优先读取 ssr.config.js (新的企业级配置)
      let configPath = resolve(rootDir, 'ssr.config.js');

      // 兼容旧的配置文件
      if (!existsSync(configPath)) {
        configPath = resolve(rootDir, 'novel-engine.config.js');
      }

      if (existsSync(configPath)) {
        try {
          const { default: config } = await import(configPath);
          this.userConfig = { ...config, ...this.userConfig };
          break;
        } catch (error) {
          console.warn(
            `Failed to load config from ${configPath}:`,
            (error as any)?.message || error
          );
        }
      }
    }

    // 转换为企业级配置格式
    this.userConfig = this.normalizeConfig(this.userConfig);
  }

  /**
   * 配置标准化 - 将各种配置格式转换为企业级标准
   * 提供完整的默认配置，确保零配置可用
   */
  normalizeConfig(config: Record<string, any> = {}): Record<string, any> {
    // 在开发模式下，默认使用ISR，避免SSG预生成问题
    const isDev = process.env.NODE_ENV !== 'production';

    const normalized = {
      mode: config.mode || RenderModes.ISR,
      // 默认路由配置 - 零配置时使用
      routes:
        config.routes ||
        (isDev
          ? {
              '/': 'isr', // 开发模式：首页使用ISR
              '/about': 'isr', // 开发模式：关于页面使用ISR
              '/*': 'isr', // 开发模式：其他页面使用ISR
            }
          : {
              '/': 'ssg', // 生产模式：首页静态生成
              '/about': 'ssg', // 生产模式：关于页面静态生成
              '/*': 'isr', // 生产模式：其他页面使用ISR
            }),
      server: {
        port: config.server?.port || config.app?.port || 3000,
        host: config.server?.host || config.app?.host || 'localhost',
      },
      isr: {
        revalidate: config.isr?.revalidate || config.render?.revalidate || 3600,
        backgroundRevalidation: config.isr?.backgroundRevalidation !== false,
      },
      cache: {
        strategy:
          config.cache?.strategy || config.render?.cache?.strategy || 'memory',
        ttl: config.cache?.ttl || config.render?.cache?.ttl || 3600,
      },
      seo: {
        enabled: config.seo?.enabled !== false,
        generateSitemap: config.seo?.generateSitemap !== false,
        generateRobots: config.seo?.generateRobots !== false,
        baseUrl:
          config.seo?.baseUrl || config.app?.domain || 'http://localhost:3000',
      },
      dev: {
        verbose: config.dev?.verbose !== false, // 默认开启详细日志
        hmr: config.dev?.hmr !== false, // 默认开启 HMR
      },
    };

    return normalized;
  }

  /**
   * 创建企业级 ISR 配置
   */
  createEnterpriseConfig() {
    const isProduction = process.env.NODE_ENV === 'production';

    const config = new EnterpriseConfig({
      mode: this.userConfig.mode,
      routes: this.userConfig.routes,

      // Server configuration handled in server object
      server: {
        port: this.userConfig.server?.port || 3000,
        host: this.userConfig.server?.host || 'localhost',
      },

      isr: {
        revalidate: this.userConfig.isr?.revalidate || 3600,
        backgroundRevalidation:
          this.userConfig.isr?.backgroundRevalidation !== false,
      },

      cache: {
        strategy: isProduction
          ? 'redis'
          : this.userConfig.cache?.strategy || 'memory',
        ttl: this.userConfig.cache?.ttl || 3600,
      },

      seo: {
        enabled: this.userConfig.seo?.enabled !== false,
        generateSitemap: this.userConfig.seo?.generateSitemap !== false,
        generateRobots: this.userConfig.seo?.generateRobots !== false,
        baseUrl: this.userConfig.seo?.baseUrl || 'http://localhost:3000',
      },

      dev: {
        verbose: this.userConfig.dev?.verbose !== false,
        hmr: this.userConfig.dev?.hmr !== false,
      },
    });

    return config;
  }

  /**
   * 开发模式启动
   */
  async dev() {
    console.log('🔧 Starting development server...');

    await this.initialize();

    // 创建企业级 ISR 应用
    const factory = new ISRFactory(this.config!.getEngineConfig());
    this.isrApp = factory.create();

    // 启动开发服务器
    this.server = await this.isrApp.start();

    const { server } = this.userConfig;

    console.log('✅ Development server started!');
    console.log(
      `🌐 Local:    http://${server?.host || 'localhost'}:${server?.port || 3000}`
    );
    console.log(
      `📊 Health:   http://${server?.host || 'localhost'}:${server?.port || 3000}/health`
    );

    this.setupGracefulShutdown();

    return this.server;
  }

  /**
   * 生产构建
   */
  async build() {
    console.log('📦 Building for production...');

    await this.initialize();

    // 运行构建流程
    await this.runBuildProcess();

    console.log('✅ Build completed!');
  }

  /**
   * 运行构建流程 (使用 Vite)
   */
  private async runBuildProcess(): Promise<void> {
    // 创建 ISR 应用用于构建
    const factory = new ISRFactory(this.config!.getEngineConfig());
    this.isrApp = factory.create();

    // 使用 ISREngine 的 Vite 构建方法
    await this.isrApp.buildWithVite();
  }

  /**
   * 生产模式启动
   */
  async start() {
    console.log('🚀 Starting production server...');

    await this.initialize();

    // 创建 ISR 应用
    const factory = new ISRFactory(this.config!.getEngineConfig());
    this.isrApp = factory.create();

    // 启动生产服务器
    this.server = await this.isrApp.start();

    const { server } = this.userConfig;

    console.log('✅ Production server started!');
    console.log(
      `🌐 Server: http://${server?.host || 'localhost'}:${server?.port || 3000}`
    );

    this.setupGracefulShutdown();

    return this.server;
  }

  /**
   * 部署模式 - 构建并生成部署资源
   */
  async deploy() {
    console.log('🚀 Starting deployment process...');

    try {
      await this.initialize();

      console.log('🧹 Cleaning previous build...');
      const rimraf = await import('rimraf');
      await rimraf.rimraf(resolve(process.cwd(), 'dist'));

      console.log('🔨 Building application...');
      await this.runBuildProcess();

      await this.generateDeploymentInfo();

      console.log('✅ Deployment assets generated successfully!');
      console.log('📁 Output directory: dist/');
      console.log('🌐 Ready for deployment to production!');
    } catch (error) {
      console.error('❌ Deployment failed:', error);
      throw error;
    }
  }

  /**
   * 生成部署信息
   */
  async generateDeploymentInfo() {
    const deployInfo = {
      timestamp: new Date().toISOString(),
      mode: this.userConfig.mode,
      features: {
        ssr: true,
        isr: true,
        ssg: true,
        seo: this.userConfig.seo?.enabled || false,
      },
      routes: Object.keys(this.userConfig.routes || {}),
      build: {
        node: process.version,
        platform: process.platform,
      },
    };

    const fs = await import('fs/promises');
    const deployPath = resolve(process.cwd(), 'dist/deployment-info.json');
    await fs.writeFile(
      deployPath,
      JSON.stringify(deployInfo, null, 2),
      'utf-8'
    );

    console.log('📄 Generated deployment-info.json');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    if (!this.isrApp) {
      return { error: 'Engine not initialized' };
    }

    return {
      engine: this.isrApp.getStats(),
      config: {
        mode: this.config?.globalMode || 'isr',
        routes: Object.keys(this.userConfig.routes || {}).length,
        seo: this.userConfig.seo?.enabled || false,
        cache: this.userConfig.cache?.strategy || 'memory',
      },
    };
  }

  /**
   * 设置优雅退出
   */
  setupGracefulShutdown() {
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

      if (this.server) {
        this.server.close(async () => {
          try {
            if (this.isrApp) {
              await this.isrApp.shutdown();
            }
            console.log('✅ Server shutdown complete');
            process.exit(0);
          } catch (error) {
            console.error('❌ Error during shutdown:', error);
            process.exit(1);
          }
        });
      }

      setTimeout(() => {
        console.error('❌ Forced exit after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }
}

/**
 * ISR Factory - 创建 ISR 实例
 */
export class ISRFactory {
  private config: Record<string, any>;

  constructor(config: Record<string, any>) {
    this.config = config;
  }

  create() {
    return new ISREngine(this.config);
  }
}

/**
 * 主要导出函数 - NPM 包用户使用的工厂函数
 */
export function createNovelEngine(config: Record<string, any> = {}) {
  return new NovelEngine(config);
}
