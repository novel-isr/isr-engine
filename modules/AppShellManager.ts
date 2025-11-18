/**
 * 企业级 AppShell 管理器
 *
 * 核心功能：
 * - 共享应用外壳（AppShell）管理
 * - 多入口架构支持
 * - 极小 entry 层实现
 * - 组件缓存和优化
 * - 运行时模块隔离
 */

import path from 'path';
import fs from 'fs/promises';
import { Logger } from '../utils/Logger';

export interface AppShellConfig {
  // 基础配置
  enabled: boolean;
  template: string;

  // 多入口配置
  multiEntry: {
    enabled: boolean;
    entries: Record<
      string,
      {
        path: string;
        dependencies?: string[];
        lazy?: boolean;
        preload?: boolean;
      }
    >;
  };

  // 共享资源配置
  sharedResources: {
    components: string[];
    styles: string[];
    libraries: string[];
  };

  // 缓存配置
  caching: {
    enabled: boolean;
    strategy: 'memory' | 'disk' | 'hybrid';
    ttl: number;
  };

  // 优化配置
  optimization: {
    codeSplitting: boolean;
    preloadCritical: boolean;
    lazyLoadNonCritical: boolean;
    bundleAnalysis: boolean;
  };
}

export interface AppShellEntry {
  id: string;
  path: string;
  component: any;
  dependencies: string[];
  metadata: {
    size: number;
    lastModified: number;
    version: string;
  };
  cached: boolean;
}

export interface AppShellManifest {
  version: string;
  timestamp: number;
  appShell: {
    template: string;
    size: number;
    dependencies: string[];
  };
  entries: Record<string, AppShellEntry>;
  sharedChunks: {
    vendor: string[];
    common: string[];
  };
  optimizations: {
    criticalCSS: string;
    preloadLinks: string[];
    lazyChunks: string[];
  };
}

/**
 * 企业级 AppShell 管理器实现
 */
export class AppShellManager {
  private config: AppShellConfig;
  private logger: Logger;
  private manifest: AppShellManifest;
  private entryCache: Map<string, AppShellEntry>;
  private componentRegistry: Map<string, any>;
  private projectRoot: string;

  constructor(projectRoot: string, config: Partial<AppShellConfig> = {}, verbose = false) {
    this.projectRoot = projectRoot;
    this.logger = new Logger(verbose);
    this.entryCache = new Map();
    this.componentRegistry = new Map();

    // 默认配置
    this.config = {
      enabled: true,
      template: 'src/App.tsx',
      multiEntry: {
        enabled: false,
        entries: {},
      },
      sharedResources: {
        components: ['src/components/Layout', 'src/components/ErrorBoundary'],
        styles: ['src/styles/global.css', 'src/styles/variables.css'],
        libraries: ['react', 'react-dom', 'react-router-dom'],
      },
      caching: {
        enabled: true,
        strategy: 'hybrid',
        ttl: 3600,
      },
      optimization: {
        codeSplitting: true,
        preloadCritical: true,
        lazyLoadNonCritical: true,
        bundleAnalysis: false,
      },
      ...config,
    };

    // 初始化清单
    this.manifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      appShell: {
        template: this.config.template,
        size: 0,
        dependencies: [],
      },
      entries: {},
      sharedChunks: {
        vendor: this.config.sharedResources.libraries,
        common: [],
      },
      optimizations: {
        criticalCSS: '',
        preloadLinks: [],
        lazyChunks: [],
      },
    };
  }

  /**
   * 初始化 AppShell 管理器
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('🏗️ 初始化企业级 AppShell 管理器...');

      // 验证 AppShell 模板
      await this.validateAppShellTemplate();

      // 发现和注册入口点
      if (this.config.multiEntry.enabled) {
        await this.discoverEntries();
      }

      // 分析共享资源
      await this.analyzeSharedResources();

      // 生成优化清单
      await this.generateManifest();

      // 设置缓存策略
      if (this.config.caching.enabled) {
        await this.setupCaching();
      }

      this.logger.info('✅ AppShell 管理器初始化完成');
    } catch (error) {
      this.logger.error('❌ AppShell 管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 验证 AppShell 模板
   */
  private async validateAppShellTemplate(): Promise<void> {
    const templatePath = path.resolve(this.projectRoot, this.config.template);

    try {
      await fs.access(templatePath);
      this.logger.debug(`✅ AppShell 模板验证成功: ${templatePath}`);
    } catch (error) {
      throw new Error(`AppShell 模板不存在: ${templatePath}`);
    }
  }

  /**
   * 发现和注册入口点
   */
  private async discoverEntries(): Promise<void> {
    this.logger.debug('🔍 发现多入口点...');

    for (const [entryId, entryConfig] of Object.entries(this.config.multiEntry.entries)) {
      try {
        const entryPath = path.resolve(this.projectRoot, entryConfig.path);
        const stats = await fs.stat(entryPath);

        const entry: AppShellEntry = {
          id: entryId,
          path: entryConfig.path,
          component: null, // 懒加载时设置
          dependencies: entryConfig.dependencies || [],
          metadata: {
            size: stats.size,
            lastModified: stats.mtime.getTime(),
            version: '1.0.0',
          },
          cached: false,
        };

        this.entryCache.set(entryId, entry);
        this.manifest.entries[entryId] = entry;

        this.logger.debug(`📝 注册入口点: ${entryId} -> ${entryConfig.path}`);
      } catch (error) {
        this.logger.warn(`⚠️ 入口点注册失败: ${entryId} -> ${entryConfig.path}`, error);
      }
    }
  }

  /**
   * 分析共享资源
   */
  private async analyzeSharedResources(): Promise<void> {
    this.logger.debug('📊 分析共享资源...');

    // 分析共享组件
    const sharedComponents = [];
    for (const componentPath of this.config.sharedResources.components) {
      try {
        const fullPath = path.resolve(this.projectRoot, componentPath);
        await fs.access(fullPath + '.tsx').catch(() => fs.access(fullPath + '.ts'));
        sharedComponents.push(componentPath);
      } catch (error) {
        this.logger.warn(`⚠️ 共享组件不存在: ${componentPath}`);
      }
    }

    // 更新清单
    this.manifest.sharedChunks.common = sharedComponents;
    this.manifest.appShell.dependencies = [
      ...this.config.sharedResources.libraries,
      ...sharedComponents,
    ];
  }

  /**
   * 生成优化清单
   */
  private async generateManifest(): Promise<void> {
    try {
      // 生成预加载链接
      if (this.config.optimization.preloadCritical) {
        this.manifest.optimizations.preloadLinks = this.generatePreloadLinks();
      }

      // 生成懒加载块
      if (this.config.optimization.lazyLoadNonCritical) {
        this.manifest.optimizations.lazyChunks = this.generateLazyChunks();
      }

      // 保存清单到磁盘
      const manifestPath = path.resolve(this.projectRoot, '.vite/appshell-manifest.json');
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify(this.manifest, null, 2));

      this.logger.debug('📄 AppShell 清单已生成');
    } catch (error) {
      this.logger.warn('⚠️ 清单生成失败:', error);
    }
  }

  /**
   * 生成预加载链接
   */
  private generatePreloadLinks(): string[] {
    const preloadLinks = [];

    // 预加载共享库
    for (const lib of this.config.sharedResources.libraries) {
      preloadLinks.push(`/node_modules/${lib}/index.js`);
    }

    // 预加载关键CSS
    for (const style of this.config.sharedResources.styles) {
      preloadLinks.push(`/${style}`);
    }

    return preloadLinks;
  }

  /**
   * 生成懒加载块
   */
  private generateLazyChunks(): string[] {
    const lazyChunks = [];

    // 非关键入口点懒加载
    for (const [entryId, entry] of this.entryCache.entries()) {
      const entryConfig = this.config.multiEntry.entries[entryId];
      if (entryConfig?.lazy) {
        lazyChunks.push(entry.path);
      }
    }

    return lazyChunks;
  }

  /**
   * 设置缓存策略
   */
  private async setupCaching(): Promise<void> {
    this.logger.debug('🗄️ 设置 AppShell 缓存策略...');

    // 根据策略设置缓存
    switch (this.config.caching.strategy) {
      case 'memory':
        // 内存缓存 - 适合开发环境
        this.setupMemoryCache();
        break;
      case 'disk':
        // 磁盘缓存 - 适合生产环境
        await this.setupDiskCache();
        break;
      case 'hybrid':
        // 混合缓存 - 内存 + 磁盘
        this.setupMemoryCache();
        await this.setupDiskCache();
        break;
    }
  }

  /**
   * 设置内存缓存
   */
  private setupMemoryCache(): void {
    // 实现内存缓存逻辑
    this.logger.debug('💾 内存缓存已启用');
  }

  /**
   * 设置磁盘缓存
   */
  private async setupDiskCache(): Promise<void> {
    const cacheDir = path.resolve(this.projectRoot, '.isr-hyou/appshell');
    await fs.mkdir(cacheDir, { recursive: true });
    this.logger.debug(`💿 磁盘缓存已启用: ${cacheDir}`);
  }

  /**
   * 获取入口点组件
   */
  async getEntry(entryId: string): Promise<AppShellEntry | null> {
    const entry = this.entryCache.get(entryId);
    if (!entry) {
      return null;
    }

    // 如果组件未加载，进行懒加载
    if (!entry.component) {
      try {
        const componentPath = path.resolve(this.projectRoot, entry.path);
        entry.component = await import(/* @vite-ignore */ componentPath);
        entry.cached = true;
        this.logger.debug(`📦 懒加载入口组件: ${entryId}`);
      } catch (error) {
        this.logger.error(`❌ 入口组件加载失败: ${entryId}`, error);
        return null;
      }
    }

    return entry;
  }

  /**
   * 获取 AppShell 模板
   */
  async getAppShellTemplate(): Promise<any> {
    const templatePath = path.resolve(this.projectRoot, this.config.template);

    try {
      return await import(/* @vite-ignore */ templatePath);
    } catch (error) {
      this.logger.error('❌ AppShell 模板加载失败:', error);
      throw error;
    }
  }

  /**
   * 生成运行时配置
   */
  generateRuntimeConfig(): any {
    return {
      appShell: {
        template: this.config.template,
        multiEntry: this.config.multiEntry.enabled,
        entries: Object.keys(this.config.multiEntry.entries),
      },
      optimization: {
        preloadLinks: this.manifest.optimizations.preloadLinks,
        lazyChunks: this.manifest.optimizations.lazyChunks,
        criticalCSS: this.manifest.optimizations.criticalCSS,
      },
      caching: {
        enabled: this.config.caching.enabled,
        strategy: this.config.caching.strategy,
      },
    };
  }

  /**
   * 获取性能指标
   */
  getPerformanceMetrics(): any {
    return {
      entryCount: this.entryCache.size,
      cachedEntries: Array.from(this.entryCache.values()).filter(e => e.cached).length,
      sharedResourcesCount: this.config.sharedResources.components.length,
      manifestSize: JSON.stringify(this.manifest).length,
      optimizations: {
        preloadLinks: this.manifest.optimizations.preloadLinks.length,
        lazyChunks: this.manifest.optimizations.lazyChunks.length,
      },
    };
  }

  /**
   * 清理缓存
   */
  async clearCache(): Promise<void> {
    this.logger.debug('🧹 清理 AppShell 缓存...');

    // 清理内存缓存
    this.entryCache.clear();
    this.componentRegistry.clear();

    // 清理磁盘缓存
    if (this.config.caching.strategy === 'disk' || this.config.caching.strategy === 'hybrid') {
      try {
        const cacheDir = path.resolve(this.projectRoot, '.isr-hyou/appshell');
        await fs.rm(cacheDir, { recursive: true, force: true });
        this.logger.debug('💿 磁盘缓存已清理');
      } catch (error) {
        this.logger.warn('⚠️ 磁盘缓存清理失败:', error);
      }
    }
  }

  /**
   * 热更新入口点
   */
  async hotUpdateEntry(entryId: string): Promise<boolean> {
    const entry = this.entryCache.get(entryId);
    if (!entry) {
      return false;
    }

    try {
      // 重新加载组件
      const componentPath = path.resolve(this.projectRoot, entry.path);

      // 清除 require 缓存 (Node.js)
      delete require.cache[require.resolve(componentPath)];

      // 重新导入
      entry.component = await import(/* @vite-ignore */ componentPath + '?t=' + Date.now());
      entry.metadata.lastModified = Date.now();

      this.logger.debug(`🔄 热更新入口组件: ${entryId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ 入口组件热更新失败: ${entryId}`, error);
      return false;
    }
  }

  /**
   * 关闭管理器
   */
  async shutdown(): Promise<void> {
    this.logger.debug('🛑 关闭 AppShell 管理器...');

    await this.clearCache();

    this.logger.debug('✅ AppShell 管理器已关闭');
  }
}

/**
 * 工厂函数：创建 AppShell 管理器实例
 */
export function createAppShellManager(
  projectRoot: string,
  config: Partial<AppShellConfig> = {}
): AppShellManager {
  return new AppShellManager(projectRoot, config);
}
