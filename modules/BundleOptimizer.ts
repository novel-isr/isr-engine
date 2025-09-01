/**
 * Bundle优化和智能预加载系统
 * 提供代码分割、资源优先级管理、预加载策略等功能
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';

export interface BundleAnalysis {
  chunks: Array<{
    name: string;
    size: number;
    files: string[];
    modules: string[];
    dependencies: string[];
  }>;
  assets: Array<{
    name: string;
    size: number;
    type: 'js' | 'css' | 'image' | 'font' | 'other';
    critical: boolean;
  }>;
  duplicates: Array<{
    module: string;
    chunks: string[];
    totalSize: number;
  }>;
  recommendations: string[];
}

export interface PreloadStrategy {
  name: string;
  condition: (context: PreloadContext) => boolean;
  resources: (context: PreloadContext) => PreloadResource[];
  priority: number;
}

export interface PreloadContext {
  currentRoute: string;
  userAgent: string;
  connectionType: string;
  deviceMemory?: number;
  isBot: boolean;
  previousRoutes: string[];
  timeOnPage: number;
}

export interface PreloadResource {
  url: string;
  type: 'script' | 'style' | 'font' | 'image' | 'prefetch' | 'preconnect';
  priority: 'high' | 'medium' | 'low';
  crossorigin?: boolean;
  media?: string;
  as?: string;
}

export interface OptimizationConfig {
  bundleAnalysis: {
    enabled: boolean;
    outputPath: string;
    threshold: {
      chunkSizeWarning: number; // bytes
      duplicateThreshold: number; // bytes
    };
  };
  preload: {
    enabled: boolean;
    maxPreloadItems: number;
    adaptiveLoading: boolean;
    strategies: PreloadStrategy[];
  };
  codesplitting: {
    vendorChunkThreshold: number;
    asyncChunkThreshold: number;
    maxInitialChunks: number;
  };
}

/**
 * Bundle分析器
 */
export class BundleAnalyzer {
  private config: OptimizationConfig;
  private logger: Logger;

  constructor(config: OptimizationConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
  }

  /**
   * 分析Webpack bundle
   */
  async analyzeWebpackStats(statsPath: string): Promise<BundleAnalysis> {
    try {
      const stats = JSON.parse(await fs.promises.readFile(statsPath, 'utf-8'));
      return this.processWebpackStats(stats);
    } catch (error) {
      this.logger.error('分析Webpack统计失败:', error);
      throw error;
    }
  }

  /**
   * 分析Vite bundle
   */
  async analyzeViteBuild(buildPath: string): Promise<BundleAnalysis> {
    try {
      const manifestPath = path.join(buildPath, 'manifest.json');
      let manifest = {};

      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      }

      return this.processViteManifest(manifest, buildPath);
    } catch (error) {
      this.logger.error('分析Vite构建失败:', error);
      throw error;
    }
  }

  private processWebpackStats(stats: any): BundleAnalysis {
    const chunks =
      stats.chunks?.map((chunk: any) => ({
        name: chunk.names?.[0] || chunk.id,
        size: chunk.size || 0,
        files: chunk.files || [],
        modules: chunk.modules?.map((m: any) => m.name) || [],
        dependencies: this.extractDependencies(chunk.modules),
      })) || [];

    const assets =
      stats.assets?.map((asset: any) => ({
        name: asset.name,
        size: asset.size,
        type: this.getAssetType(asset.name),
        critical: this.isCriticalAsset(asset.name),
      })) || [];

    const duplicates = this.findDuplicateModules(chunks);
    const recommendations = this.generateRecommendations(chunks, assets, duplicates);

    return { chunks, assets, duplicates, recommendations };
  }

  private processViteManifest(manifest: any, buildPath: string): BundleAnalysis {
    const chunks: BundleAnalysis['chunks'] = [];
    const assets: BundleAnalysis['assets'] = [];

    // 遍历manifest中的条目
    for (const [key, entry] of Object.entries(manifest)) {
      const typedEntry = entry as any;

      if (typedEntry.isEntry) {
        chunks.push({
          name: key,
          size: this.getFileSize(path.join(buildPath, typedEntry.file)),
          files: [typedEntry.file, ...(typedEntry.css || [])],
          modules: [key],
          dependencies: typedEntry.imports || [],
        });
      }

      assets.push({
        name: typedEntry.file,
        size: this.getFileSize(path.join(buildPath, typedEntry.file)),
        type: this.getAssetType(typedEntry.file),
        critical: this.isCriticalAsset(typedEntry.file),
      });

      // 添加CSS资源
      if (typedEntry.css) {
        for (const cssFile of typedEntry.css) {
          assets.push({
            name: cssFile,
            size: this.getFileSize(path.join(buildPath, cssFile)),
            type: 'css' as const,
            critical: this.isCriticalAsset(cssFile),
          });
        }
      }
    }

    const duplicates = this.findDuplicateModules(chunks);
    const recommendations = this.generateRecommendations(chunks, assets, duplicates);

    return { chunks, assets, duplicates, recommendations };
  }

  private getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private getAssetType(filename: string): BundleAnalysis['assets'][0]['type'] {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.js':
      case '.mjs':
      case '.ts':
        return 'js';
      case '.css':
      case '.scss':
      case '.sass':
        return 'css';
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.svg':
      case '.webp':
        return 'image';
      case '.woff':
      case '.woff2':
      case '.ttf':
      case '.otf':
        return 'font';
      default:
        return 'other';
    }
  }

  private isCriticalAsset(filename: string): boolean {
    const criticalPatterns = [
      /index\.(js|css)$/,
      /main\.(js|css)$/,
      /app\.(js|css)$/,
      /critical\.(js|css)$/,
      /vendor\.(js|css)$/,
    ];

    return criticalPatterns.some(pattern => pattern.test(filename));
  }

  private extractDependencies(modules: any[] = []): string[] {
    const dependencies = new Set<string>();

    for (const module of modules) {
      if (module.reasons) {
        for (const reason of module.reasons) {
          if (reason.moduleName) {
            dependencies.add(reason.moduleName);
          }
        }
      }
    }

    return Array.from(dependencies);
  }

  private findDuplicateModules(chunks: BundleAnalysis['chunks']): BundleAnalysis['duplicates'] {
    const moduleChunkMap = new Map<string, string[]>();
    const duplicates: BundleAnalysis['duplicates'] = [];

    // 构建模块到chunk的映射
    for (const chunk of chunks) {
      for (const module of chunk.modules) {
        if (!moduleChunkMap.has(module)) {
          moduleChunkMap.set(module, []);
        }
        moduleChunkMap.get(module)!.push(chunk.name);
      }
    }

    // 找出重复模块
    for (const [module, chunkList] of moduleChunkMap) {
      if (chunkList.length > 1) {
        const totalSize = chunkList.reduce((size, chunkName) => {
          const chunk = chunks.find(c => c.name === chunkName);
          return size + (chunk?.size || 0) / chunk!.modules.length; // 平均分配大小
        }, 0);

        if (totalSize > this.config.bundleAnalysis.threshold.duplicateThreshold) {
          duplicates.push({
            module,
            chunks: chunkList,
            totalSize,
          });
        }
      }
    }

    return duplicates;
  }

  private generateRecommendations(
    chunks: BundleAnalysis['chunks'],
    assets: BundleAnalysis['assets'],
    duplicates: BundleAnalysis['duplicates']
  ): string[] {
    const recommendations: string[] = [];

    // 检查chunk大小
    for (const chunk of chunks) {
      if (chunk.size > this.config.bundleAnalysis.threshold.chunkSizeWarning) {
        recommendations.push(
          `Chunk "${chunk.name}" 过大 (${(chunk.size / 1024).toFixed(1)}KB)，考虑进一步分割`
        );
      }
    }

    // 检查重复模块
    if (duplicates.length > 0) {
      recommendations.push(`发现 ${duplicates.length} 个重复模块，考虑提取公共chunk`);
    }

    // 检查关键资源
    const criticalAssets = assets.filter(a => a.critical);
    const totalCriticalSize = criticalAssets.reduce((sum, a) => sum + a.size, 0);

    if (totalCriticalSize > 200 * 1024) {
      // 200KB
      recommendations.push(
        `关键资源过大 (${(totalCriticalSize / 1024).toFixed(1)}KB)，考虑优化首屏加载`
      );
    }

    // 检查资源类型分布
    const imageAssets = assets.filter(a => a.type === 'image');
    const totalImageSize = imageAssets.reduce((sum, a) => sum + a.size, 0);

    if (totalImageSize > 1024 * 1024) {
      // 1MB
      recommendations.push(
        `图片资源过大 (${(totalImageSize / 1024 / 1024).toFixed(1)}MB)，考虑压缩或懒加载`
      );
    }

    return recommendations;
  }

  /**
   * 生成优化报告
   */
  async generateReport(analysis: BundleAnalysis, outputPath: string): Promise<void> {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalChunks: analysis.chunks.length,
        totalAssets: analysis.assets.length,
        totalSize: analysis.assets.reduce((sum, a) => sum + a.size, 0),
        duplicateModules: analysis.duplicates.length,
        recommendations: analysis.recommendations.length,
      },
      analysis,
    };

    const reportPath = path.join(outputPath, 'bundle-analysis.json');
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));

    // 生成HTML报告
    const htmlReport = this.generateHtmlReport(report);
    const htmlPath = path.join(outputPath, 'bundle-analysis.html');
    await fs.promises.writeFile(htmlPath, htmlReport);

    this.logger.info(`Bundle分析报告已生成: ${reportPath}`);
  }

  private generateHtmlReport(report: any): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Bundle Analysis Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .summary { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
    .section { margin-bottom: 30px; }
    .chunk, .asset { margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 3px; }
    .critical { border-left: 4px solid #f44336; }
    .large { border-left: 4px solid #ff9800; }
    .recommendation { background: #fff3cd; padding: 10px; margin: 5px 0; border-radius: 3px; }
    .size { float: right; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Bundle Analysis Report</h1>
  <p>Generated: ${report.timestamp}</p>
  
  <div class="summary">
    <h2>Summary</h2>
    <p>Total Chunks: ${report.summary.totalChunks}</p>
    <p>Total Assets: ${report.summary.totalAssets}</p>
    <p>Total Size: ${(report.summary.totalSize / 1024).toFixed(1)} KB</p>
    <p>Duplicate Modules: ${report.summary.duplicateModules}</p>
    <p>Recommendations: ${report.summary.recommendations}</p>
  </div>
  
  <div class="section">
    <h2>Recommendations</h2>
    ${report.analysis.recommendations
      .map((r: string) => `<div class="recommendation">${r}</div>`)
      .join('')}
  </div>
  
  <div class="section">
    <h2>Chunks</h2>
    ${report.analysis.chunks
      .map(
        (chunk: any) => `
      <div class="chunk ${chunk.size > 100000 ? 'large' : ''}">
        <strong>${chunk.name}</strong>
        <span class="size">${(chunk.size / 1024).toFixed(1)} KB</span>
        <div>Files: ${chunk.files.join(', ')}</div>
        <div>Modules: ${chunk.modules.length}</div>
      </div>
    `
      )
      .join('')}
  </div>
  
  <div class="section">
    <h2>Assets</h2>
    ${report.analysis.assets
      .map(
        (asset: any) => `
      <div class="asset ${asset.critical ? 'critical' : ''}">
        <strong>${asset.name}</strong>
        <span class="size">${(asset.size / 1024).toFixed(1)} KB</span>
        <div>Type: ${asset.type} ${asset.critical ? '(Critical)' : ''}</div>
      </div>
    `
      )
      .join('')}
  </div>
  
</body>
</html>
    `;
  }
}

/**
 * 智能预加载管理器
 */
export class IntelligentPreloader {
  private config: OptimizationConfig;
  private logger: Logger;
  private preloadCache = new Map<string, PreloadResource[]>();
  private performanceMetrics = new Map<string, number>();

  constructor(config: OptimizationConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
    this.setupDefaultStrategies();
  }

  private setupDefaultStrategies(): void {
    // 关键资源预加载
    this.addStrategy({
      name: 'critical-resources',
      condition: () => true,
      resources: context => this.getCriticalResources(context),
      priority: 100,
    });

    // 基于用户行为的预加载
    this.addStrategy({
      name: 'user-behavior',
      condition: context => context.timeOnPage > 5000, // 5秒后
      resources: context => this.getUserBehaviorResources(context),
      priority: 80,
    });

    // 网络适应性预加载
    this.addStrategy({
      name: 'adaptive-loading',
      condition: context => this.config.preload.adaptiveLoading,
      resources: context => this.getAdaptiveResources(context),
      priority: 60,
    });

    // 路由预测预加载
    this.addStrategy({
      name: 'route-prediction',
      condition: context => context.previousRoutes.length > 2,
      resources: context => this.getPredictedRouteResources(context),
      priority: 40,
    });
  }

  addStrategy(strategy: PreloadStrategy): void {
    this.config.preload.strategies.push(strategy);
    this.config.preload.strategies.sort((a, b) => b.priority - a.priority);
  }

  async generatePreloadTags(context: PreloadContext): Promise<string> {
    if (!this.config.preload.enabled) {
      return '';
    }

    const resources = await this.getPreloadResources(context);
    const limitedResources = resources.slice(0, this.config.preload.maxPreloadItems);

    return limitedResources.map(resource => this.generatePreloadTag(resource)).join('\n');
  }

  private async getPreloadResources(context: PreloadContext): Promise<PreloadResource[]> {
    const allResources: PreloadResource[] = [];

    for (const strategy of this.config.preload.strategies) {
      if (strategy.condition(context)) {
        try {
          const strategyResources = strategy.resources(context);
          allResources.push(...strategyResources);
        } catch (error) {
          this.logger.error(`预加载策略 ${strategy.name} 执行失败:`, error);
        }
      }
    }

    // 去重和排序
    const uniqueResources = this.deduplicateResources(allResources);
    return this.sortResourcesByPriority(uniqueResources);
  }

  private getCriticalResources(context: PreloadContext): PreloadResource[] {
    const resources: PreloadResource[] = [];

    // 预加载关键字体
    resources.push({
      url: '/fonts/main.woff2',
      type: 'font',
      priority: 'high',
      crossorigin: true,
      as: 'font',
    });

    // 预连接到重要的第三方域名
    resources.push({
      url: 'https://fonts.googleapis.com',
      type: 'preconnect',
      priority: 'high',
      crossorigin: true,
    });

    resources.push({
      url: 'https://fonts.gstatic.com',
      type: 'preconnect',
      priority: 'high',
      crossorigin: true,
    });

    return resources;
  }

  private getUserBehaviorResources(context: PreloadContext): PreloadResource[] {
    const resources: PreloadResource[] = [];

    // 基于用户之前的路由预测可能的下一个页面
    const likelyNextRoutes = this.predictNextRoutes(context.previousRoutes, context.currentRoute);

    for (const route of likelyNextRoutes) {
      resources.push({
        url: route,
        type: 'prefetch',
        priority: 'low',
      });
    }

    return resources;
  }

  private getAdaptiveResources(context: PreloadContext): PreloadResource[] {
    const resources: PreloadResource[] = [];

    // 根据连接类型调整预加载策略
    if (context.connectionType === 'slow-2g' || context.connectionType === '2g') {
      // 慢速连接，只预加载最关键的资源
      return resources;
    }

    // 根据设备内存调整预加载量
    const deviceMemory = context.deviceMemory || 4;
    const maxPreloadItems = deviceMemory > 4 ? 10 : deviceMemory > 2 ? 5 : 2;

    // 动态调整预加载项目数量
    if (resources.length > maxPreloadItems) {
      return resources.slice(0, maxPreloadItems);
    }

    return resources;
  }

  private getPredictedRouteResources(context: PreloadContext): PreloadResource[] {
    const resources: PreloadResource[] = [];
    const predictedRoutes = this.predictNextRoutes(context.previousRoutes, context.currentRoute);

    for (const route of predictedRoutes.slice(0, 3)) {
      // 预取路由对应的JavaScript和CSS
      resources.push({
        url: `/assets/pages${route}.js`,
        type: 'prefetch',
        priority: 'medium',
      });

      resources.push({
        url: `/assets/pages${route}.css`,
        type: 'prefetch',
        priority: 'medium',
      });
    }

    return resources;
  }

  private predictNextRoutes(previousRoutes: string[], currentRoute: string): string[] {
    // 简单的路由预测逻辑
    const commonPatterns = [
      ['/'], // 首页
      ['/about'], // 关于页
      ['/contact'], // 联系页
    ];

    const predictions: string[] = [];

    // 基于常见模式预测
    for (const pattern of commonPatterns) {
      if (!pattern.includes(currentRoute)) {
        predictions.push(...pattern);
      }
    }

    // 基于历史记录预测
    const routeFrequency = new Map<string, number>();
    for (const route of previousRoutes) {
      routeFrequency.set(route, (routeFrequency.get(route) || 0) + 1);
    }

    const frequentRoutes = Array.from(routeFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([route]) => route);

    predictions.push(...frequentRoutes);

    return [...new Set(predictions)]; // 去重
  }

  private deduplicateResources(resources: PreloadResource[]): PreloadResource[] {
    const seen = new Set<string>();
    return resources.filter(resource => {
      const key = `${resource.url}-${resource.type}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private sortResourcesByPriority(resources: PreloadResource[]): PreloadResource[] {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    return resources.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
  }

  private generatePreloadTag(resource: PreloadResource): string {
    const attrs: string[] = [];

    switch (resource.type) {
      case 'preconnect':
        attrs.push(`rel="preconnect"`);
        attrs.push(`href="${resource.url}"`);
        if (resource.crossorigin) {
          attrs.push('crossorigin');
        }
        break;

      case 'prefetch':
        attrs.push(`rel="prefetch"`);
        attrs.push(`href="${resource.url}"`);
        break;

      case 'script':
        attrs.push(`rel="preload"`);
        attrs.push(`href="${resource.url}"`);
        attrs.push(`as="script"`);
        if (resource.crossorigin) {
          attrs.push('crossorigin');
        }
        break;

      case 'style':
        attrs.push(`rel="preload"`);
        attrs.push(`href="${resource.url}"`);
        attrs.push(`as="style"`);
        if (resource.media) {
          attrs.push(`media="${resource.media}"`);
        }
        break;

      case 'font':
        attrs.push(`rel="preload"`);
        attrs.push(`href="${resource.url}"`);
        attrs.push(`as="font"`);
        attrs.push(`type="font/woff2"`);
        attrs.push('crossorigin');
        break;

      case 'image':
        attrs.push(`rel="preload"`);
        attrs.push(`href="${resource.url}"`);
        attrs.push(`as="image"`);
        break;
    }

    return `<link ${attrs.join(' ')}>`;
  }

  /**
   * 记录预加载性能指标
   */
  recordPreloadPerformance(url: string, loadTime: number): void {
    this.performanceMetrics.set(url, loadTime);

    // 基于性能调整策略
    if (loadTime > 3000) {
      // 3秒以上
      this.logger.warn(`预加载资源 ${url} 加载时间过长: ${loadTime}ms`);
    }
  }

  /**
   * 获取预加载性能统计
   */
  getPerformanceStats(): {
    totalPreloads: number;
    avgLoadTime: number;
    slowestResource: { url: string; time: number } | null;
    recommendations: string[];
  } {
    const metrics = Array.from(this.performanceMetrics.entries());
    const totalPreloads = metrics.length;

    if (totalPreloads === 0) {
      return {
        totalPreloads: 0,
        avgLoadTime: 0,
        slowestResource: null,
        recommendations: ['暂无预加载性能数据'],
      };
    }

    const totalTime = metrics.reduce((sum, [, time]) => sum + time, 0);
    const avgLoadTime = totalTime / totalPreloads;

    const slowestResource = metrics.reduce(
      (slowest, [url, time]) => {
        return !slowest || time > slowest.time ? { url, time } : slowest;
      },
      null as { url: string; time: number } | null
    );

    const recommendations: string[] = [];

    if (avgLoadTime > 2000) {
      recommendations.push('平均预加载时间过长，考虑减少预加载项目或优化资源');
    }

    if (slowestResource && slowestResource.time > 5000) {
      recommendations.push(`最慢资源 ${slowestResource.url} 需要优化`);
    }

    const slowResources = metrics.filter(([, time]) => time > 3000).length;
    if (slowResources > totalPreloads * 0.2) {
      recommendations.push('超过20%的预加载资源过慢，建议重新评估预加载策略');
    }

    return {
      totalPreloads,
      avgLoadTime,
      slowestResource,
      recommendations,
    };
  }
}

// Classes are already exported above, no need for duplicate exports
