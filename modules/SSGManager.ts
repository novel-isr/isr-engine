/**
 * SSG 管理器 - 统一的 SSG 接口
 * 解决双实现重复问题，提供统一的 API
 */

import { SSGGenerator as UnifiedSSGGenerator, SSGConfig } from './SSGGenerator';
import { Logger } from '../utils/Logger';

export interface SSGManagerConfig extends Partial<SSGConfig> {
  // 路由发现配置
  routeDiscovery: {
    enabled: boolean;
    sources: Array<'filesystem' | 'config' | 'dynamic'>;
    patterns?: string[];
    exclude?: string[];
  };

  // 构建集成
  buildIntegration: {
    enabled: boolean;
    buildCommand?: string;
    prebuildHook?: () => Promise<void>;
    postbuildHook?: (results: any) => Promise<void>;
  };

  // 开发模式配置
  development: {
    hotReload: boolean;
    watchFiles: boolean;
    watchPatterns?: string[];
  };
}

/**
 * SSG 管理器 - 企业级 SSG 解决方案
 */
export class SSGManager {
  private generator: UnifiedSSGGenerator;
  private config: SSGManagerConfig;
  private logger: Logger;
  private isWatching = false;
  private watchHandlers: any[] = [];

  constructor(config: Partial<SSGManagerConfig> = {}, verbose = false) {
    const defaultConfig: SSGManagerConfig = {
      routes: ['/'],
      outputDir: {
        production: 'dist/client',
        development: '.isr-hyou/ssg',
      },
      onDemandGeneration: true,
      cleanupOldFiles: false,
      concurrent: 3,
      caching: {
        enabled: true,
        ttl: 3600,
      },
      routeDiscovery: {
        enabled: true,
        sources: ['filesystem', 'config'],
        exclude: ['/api/*', '/admin/*'],
      },
      buildIntegration: {
        enabled: false,
      },
      development: {
        hotReload: true,
        watchFiles: false,
      },
    };

    this.config = {
      ...defaultConfig,
      ...config,
      // 深度合并嵌套对象
      routeDiscovery: {
        ...defaultConfig.routeDiscovery,
        ...config.routeDiscovery,
      },
      buildIntegration: {
        ...defaultConfig.buildIntegration,
        ...config.buildIntegration,
      },
      development: {
        ...defaultConfig.development,
        ...config.development,
      },
      caching: {
        enabled: config.caching?.enabled ?? true,
        ttl: config.caching?.ttl ?? 3600,
      },
    };

    this.logger = new Logger(verbose);
    this.generator = new UnifiedSSGGenerator(this.config, verbose);
  }

  /**
   * 初始化 SSG 管理器
   */
  async initialize(renderFunction: (url: string, context: any) => Promise<any>) {
    this.logger.info('🚀 初始化 SSG 管理器...');

    // 设置渲染函数
    this.generator.setRenderFunction(renderFunction);

    // 发现路由
    if (this.config.routeDiscovery.enabled) {
      const discoveredRoutes = await this.discoverRoutes();
      if (discoveredRoutes.length > 0) {
        this.config.routes = discoveredRoutes;
        this.logger.info(`🔍 发现路由: ${discoveredRoutes.length} 个`);
      }
    }

    // 开发模式下启动文件监听
    if (process.env.NODE_ENV !== 'production' && this.config.development.watchFiles) {
      await this.startFileWatching();
    }

    this.logger.info('✅ SSG 管理器初始化完成');
  }

  /**
   * 预构建所有静态页面
   */
  async prebuild(): Promise<{ successful: number; failed: number; total: number }> {
    this.logger.info('🔨 开始 SSG 预构建...');

    if (this.config.buildIntegration.prebuildHook) {
      await this.config.buildIntegration.prebuildHook();
    }

    const results = await this.generator.generateAll();

    if (this.config.buildIntegration.postbuildHook) {
      await this.config.buildIntegration.postbuildHook(results);
    }

    return results;
  }

  /**
   * 按需生成页面（用于运行时）
   */
  async generateOnDemand(route: string) {
    return await this.generator.generateOnDemand(route);
  }

  /**
   * 路由发现
   */
  private async discoverRoutes(): Promise<string[]> {
    const routes = new Set<string>();
    const sources = this.config.routeDiscovery.sources;

    // 从文件系统发现路由
    if (sources.includes('filesystem')) {
      const fsRoutes = await this.discoverFromFilesystem();
      fsRoutes.forEach(route => routes.add(route));
    }

    // 从配置文件发现路由
    if (sources.includes('config')) {
      const configRoutes = await this.discoverFromConfig();
      configRoutes.forEach(route => routes.add(route));
    }

    // 动态路由发现
    if (sources.includes('dynamic')) {
      const dynamicRoutes = await this.discoverDynamicRoutes();
      dynamicRoutes.forEach(route => routes.add(route));
    }

    // 过滤排除的路由
    const filteredRoutes = Array.from(routes).filter(route => {
      return !this.config.routeDiscovery.exclude?.some(pattern => {
        return this.matchPattern(route, pattern);
      });
    });

    return filteredRoutes.sort();
  }

  /**
   * 从文件系统发现路由
   */
  private async discoverFromFilesystem(): Promise<string[]> {
    const routes: string[] = [];

    try {
      const fs = await import('fs');
      const path = await import('path');

      // 查找页面文件
      const pagesDir = path.join(process.cwd(), 'src', 'pages');
      if (fs.existsSync(pagesDir)) {
        const files = await this.walkDirectory(pagesDir);

        for (const file of files) {
          if (file.match(/\.(tsx?|jsx?)$/)) {
            const relativePath = path.relative(pagesDir, file);
            const route = this.filePathToRoute(relativePath);
            if (route) {
              routes.push(route);
            }
          }
        }
      }

      // 查找路由配置
      const routeConfigs = [
        'src/config/routes.ts',
        'src/config/routes.tsx',
        'src/routes.ts',
        'src/routes.tsx',
      ];

      for (const configPath of routeConfigs) {
        const fullPath = path.join(process.cwd(), configPath);
        if (fs.existsSync(fullPath)) {
          const configRoutes = await this.parseRouteConfig(fullPath);
          routes.push(...configRoutes);
          break;
        }
      }
    } catch (error) {
      this.logger.warn('从文件系统发现路由失败:', error);
    }

    return routes;
  }

  /**
   * 从配置文件发现路由
   */
  private async discoverFromConfig(): Promise<string[]> {
    const routes: string[] = [];

    try {
      const configFiles = ['ssg.config.js', 'ssg.config.ts', 'ssr.config.js', 'ssr.config.ts'];

      const path = await import('path');
      const fs = await import('fs');

      for (const configFile of configFiles) {
        const configPath = path.join(process.cwd(), configFile);
        if (fs.existsSync(configPath)) {
          const config = await import(/* @vite-ignore */ configPath);
          if (config.routes) {
            routes.push(...(Array.isArray(config.routes) ? config.routes : [config.routes]));
          }
          break;
        }
      }
    } catch (error) {
      this.logger.warn('从配置文件发现路由失败:', error);
    }

    return routes;
  }

  /**
   * 动态路由发现
   */
  private async discoverDynamicRoutes(): Promise<string[]> {
    // 这里可以实现从 API、数据库等动态源发现路由
    // 例如：博客文章、产品页面等
    return [];
  }

  /**
   * 文件路径转换为路由
   */
  private filePathToRoute(filePath: string): string | null {
    // 移除文件扩展名
    let route = filePath.replace(/\.(tsx?|jsx?)$/, '');

    // 处理 index 文件
    if (route.endsWith('/index') || route === 'index') {
      route = route.replace(/\/index$/, '') || '/';
    }

    // 确保以 / 开头
    if (!route.startsWith('/')) {
      route = '/' + route;
    }

    // 跳过动态路由（包含 [、] 的文件）
    if (route.includes('[') || route.includes(']')) {
      return null;
    }

    return route;
  }

  /**
   * 解析路由配置文件
   */
  private async parseRouteConfig(configPath: string): Promise<string[]> {
    try {
      const fs = await import('fs');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // 简单的正则匹配路径
      const pathMatches = content.match(/path:\s*['"`]([^'"`]+)['"`]/g);

      if (pathMatches) {
        return pathMatches
          .map(match => {
            const pathMatch = match.match(/['"`]([^'"`]+)['"`]/);
            return pathMatch ? pathMatch[1] : null;
          })
          .filter((path): path is string => {
            return path !== null && !path.includes(':') && !path.includes('*');
          });
      }
    } catch (error) {
      this.logger.warn(`解析路由配置失败 ${configPath}:`, error);
    }

    return [];
  }

  /**
   * 遍历目录
   */
  private async walkDirectory(dir: string): Promise<string[]> {
    const fs = await import('fs');
    const path = await import('path');
    const files: string[] = [];

    try {
      const items = await fs.promises.readdir(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = await fs.promises.stat(fullPath);

        if (stats.isDirectory()) {
          const subFiles = await this.walkDirectory(fullPath);
          files.push(...subFiles);
        } else {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // 目录不存在或无法读取
    }

    return files;
  }

  /**
   * 启动文件监听
   */
  private async startFileWatching(): Promise<void> {
    if (this.isWatching) return;

    try {
      const fs = await import('fs');
      const path = await import('path');

      const watchPaths = this.config.development.watchPatterns || [
        'src/pages/**/*',
        'src/config/routes.*',
        'src/routes.*',
        'ssg.config.*',
        'ssr.config.*',
      ];

      for (const pattern of watchPaths) {
        // 简化的文件监听，实际可以使用 chokidar 等库
        const watchPath = path.join(process.cwd(), 'src');
        if (fs.existsSync(watchPath)) {
          const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
            if (filename && this.shouldRegenerate(filename)) {
              this.handleFileChange(filename, eventType);
            }
          });

          this.watchHandlers.push(watcher);
        }
      }

      this.isWatching = true;
      this.logger.info('📁 SSG 文件监听已启动');
    } catch (error) {
      this.logger.warn('启动文件监听失败:', error);
    }
  }

  /**
   * 处理文件变化
   */
  private async handleFileChange(filename: string, eventType: string): Promise<void> {
    this.logger.debug(`📁 文件变化: ${filename} (${eventType})`);

    if (this.config.development.hotReload) {
      // 清理相关缓存
      await this.generator.clearCache();

      // 重新发现路由
      if (this.config.routeDiscovery.enabled) {
        const newRoutes = await this.discoverRoutes();
        this.config.routes = newRoutes;
        this.logger.debug(`🔄 路由已更新: ${newRoutes.length} 个`);
      }
    }
  }

  /**
   * 判断是否应该重新生成
   */
  private shouldRegenerate(filename: string): boolean {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
    return extensions.some(ext => filename.endsWith(ext));
  }

  /**
   * 模式匹配
   */
  private matchPattern(str: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.generator.getStats(),
      config: {
        routes: Array.isArray(this.config.routes) ? this.config.routes.length : 0,
        routeDiscovery: this.config.routeDiscovery.enabled,
        onDemandGeneration: this.config.onDemandGeneration,
        caching: this.config.caching?.enabled ?? false,
        development: {
          hotReload: this.config.development.hotReload,
          watchFiles: this.config.development.watchFiles,
          isWatching: this.isWatching,
        },
      },
    };
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    // 停止文件监听
    for (const watcher of this.watchHandlers) {
      if (watcher && typeof watcher.close === 'function') {
        watcher.close();
      }
    }
    this.watchHandlers.length = 0;
    this.isWatching = false;

    // 清理生成器缓存
    await this.generator.clearCache();

    this.logger.info('🧹 SSG 管理器已清理');
  }

  /**
   * 手动触发重新生成
   */
  async regenerate(
    routes?: string[]
  ): Promise<{ successful: number; failed: number; total: number }> {
    if (routes) {
      this.config.routes = routes;
    }

    return await this.generator.generateAll();
  }
}

// Class is already exported above, no need for duplicate export
