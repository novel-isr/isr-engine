/**
 * 企业级自动降级链引擎
 *
 * 核心功能：
 * - ISR -> SSG -> CSR 智能降级
 * - 实时健康监控和故障检测
 * - 自适应性能优化
 * - 企业级错误恢复机制
 * - 详细的指标收集和分析
 */

import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CacheManager } from '../cache/CacheManager';
import { SSGGenerator } from '../modules/SSGGenerator';
import { ISRModule } from '../modules/ISRModule';
import { CSRFallback } from '../modules/CSRFallback';
import { SEOModule } from '../modules/SEOModule';
import type { RenderContext, RenderResult, NovelISRConfig } from '../types';

export interface FallbackStrategy {
  name: 'static' | 'cached' | 'regenerate' | 'server' | 'client';
  priority: number;
  timeout: number;
  retries: number;
  condition?: (url: string, context: RenderContext) => boolean;
  healthCheck?: () => Promise<boolean>;
}

export interface FallbackChainConfig {
  strategies: FallbackStrategy[];
  defaultChain: string[];
  routeSpecific: Record<string, string[]>;
  performance: {
    enableAdaptive: boolean;
    performanceThreshold: number; // ms
    errorRateThreshold: number; // %
    adaptiveWindow: number; // 时间窗口（秒）
  };
  monitoring: {
    enableDetailedMetrics: boolean;
    enableHealthChecks: boolean;
    healthCheckInterval: number; // ms
  };
}

export interface FallbackChainMetrics {
  totalRequests: number;
  successfulFallbacks: number;
  failedRequests: number;
  strategyUsage: Record<string, number>;
  averageResponseTime: number;
  errorRates: Record<string, number>;
  adaptiveDecisions: number;
  healthCheckResults: Record<string, boolean>;
}

/**
 * 企业级自动降级链引擎实现
 */
export class FallbackChainEngine {
  private config: FallbackChainConfig;
  private logger: Logger;
  private metrics: MetricsCollector;
  private cache: CacheManager;

  // 核心模块
  private ssgGenerator: SSGGenerator;
  private isrModule: ISRModule;
  private csrFallback: CSRFallback;
  private seoModule: SEOModule;

  // 注入的服务端渲染函数
  private renderServerFn?: (url: string, context: any) => Promise<any>;

  // 运行时状态
  private strategyHealth: Map<string, boolean>;
  private performanceHistory: Array<{ strategy: string; time: number; timestamp: number }>;
  private errorHistory: Array<{ strategy: string; error: string; timestamp: number }>;
  private adaptiveDecisions: Map<string, string>; // route -> preferred strategy
  private healthCheckTimers: Map<string, NodeJS.Timeout>;

  constructor(
    config: Partial<FallbackChainConfig> = {},
    modules: {
      cache: CacheManager;
      ssgGenerator: SSGGenerator;
      isrModule: ISRModule;
      csrFallback: CSRFallback;
      seoModule: SEOModule;
      metrics: MetricsCollector;
      renderServerFn?: (url: string, context: any) => Promise<any>;
    },
    verbose = false
  ) {
    this.logger = new Logger(verbose);
    this.cache = modules.cache;
    this.metrics = modules.metrics;
    this.ssgGenerator = modules.ssgGenerator;
    this.isrModule = modules.isrModule;
    this.csrFallback = modules.csrFallback;
    this.seoModule = modules.seoModule;
    this.renderServerFn = modules.renderServerFn;

    // 初始化配置
    this.config = {
      strategies: [
        {
          name: 'cached',
          priority: 1,
          timeout: 200,
          retries: 1,
          condition: () => true,
        },
        {
          name: 'regenerate',
          priority: 2,
          timeout: 5000,
          retries: 2,
          condition: () => true,
        },
        {
          name: 'server',
          priority: 3,
          timeout: 8000,
          retries: 1,
          condition: () => true,
        },
        // 注：已移除 CSR(客户端渲染) 策略
        // {
        //   name: 'client',
        //   priority: 5,
        //   timeout: 1000,
        //   retries: 0,
        //   condition: () => true,
        // },
      ],
      // 默认降级链：移除 'client' 策略，确保完整服务端渲染
      defaultChain: ['cached', 'regenerate', 'server'],
      routeSpecific: {},
      performance: {
        enableAdaptive: true,
        performanceThreshold: 3000,
        errorRateThreshold: 10,
        adaptiveWindow: 300, // 5分钟
      },
      monitoring: {
        enableDetailedMetrics: true,
        enableHealthChecks: true,
        healthCheckInterval: 30000, // 30秒
      },
      ...config,
    };

    // 初始化运行时状态
    this.strategyHealth = new Map();
    this.performanceHistory = [];
    this.errorHistory = [];
    this.adaptiveDecisions = new Map();
    this.healthCheckTimers = new Map();

    // 初始化策略健康状态
    this.config.strategies.forEach(strategy => {
      this.strategyHealth.set(strategy.name, true);
    });
  }

  /**
   * 初始化降级链引擎
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('🔗 初始化企业级降级链引擎...');

      // 启动健康检查
      if (this.config.monitoring.enableHealthChecks) {
        await this.startHealthChecks();
      }

      // 初始化自适应优化
      if (this.config.performance.enableAdaptive) {
        this.startAdaptiveOptimization();
      }

      this.logger.info('✅ 降级链引擎初始化完成');
    } catch (error) {
      this.logger.error('❌ 降级链引擎初始化失败:', error);
      throw error;
    }
  }

  /**
   * 执行降级链渲染
   */
  async executeChain(url: string, context: RenderContext = {}): Promise<RenderResult> {
    const startTime = Date.now();
    const fallbackChain = this.getFallbackChain(url, context);
    let lastError: Error | null = null;

    this.logger.debug(`🔗 开始执行降级链: ${fallbackChain.join(' -> ')} | ${url}`);

    // 记录请求开始
    const metricsId = this.metrics.startRender(url, 'fallback-chain', 'auto');

    for (let i = 0; i < fallbackChain.length; i++) {
      const strategyName = fallbackChain[i];
      const strategy = this.config.strategies.find(s => s.name === strategyName);

      if (!strategy) {
        this.logger.warn(`⚠️ 未知策略: ${strategyName}`);
        continue;
      }

      // 检查策略健康状态
      if (!this.strategyHealth.get(strategyName)) {
        this.logger.debug(`⚠️ 跳过不健康的策略: ${strategyName}`);
        continue;
      }

      // 检查策略条件
      if (strategy.condition && !strategy.condition(url, context)) {
        this.logger.debug(`⚠️ 策略条件不满足，跳过: ${strategyName}`);
        continue;
      }

      const strategyStartTime = Date.now();
      let retries = strategy.retries + 1;

      while (retries > 0) {
        try {
          this.logger.debug(`🎯 尝试策略: ${strategyName} (剩余重试: ${retries - 1})`);

          // 执行策略
          const result = await this.executeStrategy(strategyName, url, context, strategy.timeout);

          if (result && result.success) {
            const responseTime = Date.now() - strategyStartTime;

            // 记录成功指标
            this.recordStrategySuccess(strategyName, responseTime);

            // 记录到性能历史
            this.performanceHistory.push({
              strategy: strategyName,
              time: responseTime,
              timestamp: Date.now(),
            });

            // 清理历史记录
            this.cleanupHistory();

            // 添加降级链元数据
            result.meta = {
              ...result.meta,
              strategy: strategyName,
              fallbackUsed: i > 0,
              totalResponseTime: Date.now() - startTime,
              attemptedStrategies: fallbackChain.slice(0, i + 1),
            };

            // 记录成功的渲染指标
            this.metrics.endRender(
              metricsId,
              url,
              'fallback-chain' as any,
              strategyName as any,
              startTime,
              true,
              result.statusCode || 200,
              result.html?.length || 0,
              result.meta.fromCache || false,
              undefined,
              result.meta.cacheAge,
              context.userAgent
            );

            this.logger.info(`✅ 策略成功: ${strategyName} | ${url} | ${responseTime}ms`);
            return result;
          }
        } catch (error) {
          lastError = error as Error;
          const responseTime = Date.now() - strategyStartTime;

          // 记录错误
          this.recordStrategyError(strategyName, lastError.message, responseTime);

          // 记录到错误历史
          this.errorHistory.push({
            strategy: strategyName,
            error: lastError.message,
            timestamp: Date.now(),
          });

          this.logger.warn(`❌ 策略失败: ${strategyName} | ${lastError.message}`);
        }

        retries--;

        // 如果还有重试，等待一段时间
        if (retries > 0) {
          await this.delay(100 * (strategy.retries - retries + 1));
        }
      }

      // 策略完全失败，标记为不健康
      if (this.shouldMarkUnhealthy(strategyName)) {
        this.strategyHealth.set(strategyName, false);
        this.logger.warn(`⚠️ 策略标记为不健康: ${strategyName}`);
      }
    }

    // 所有策略都失败
    const totalTime = Date.now() - startTime;

    // 记录失败的渲染指标
    this.metrics.endRender(
      metricsId,
      url,
      'fallback-chain' as any,
      'failed' as any,
      startTime,
      false,
      500,
      0,
      false,
      lastError?.message,
      undefined,
      context.userAgent
    );

    this.logger.error(`❌ 所有降级策略都失败: ${url} | ${totalTime}ms`);

    // 返回错误结果
    throw lastError || new Error('所有降级策略都失败');
  }

  /**
   * 执行具体策略
   */
  private async executeStrategy(
    strategyName: string,
    url: string,
    context: RenderContext,
    timeout: number
  ): Promise<RenderResult> {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`策略超时: ${strategyName} (${timeout}ms)`));
      }, timeout);

      try {
        let result: RenderResult;

        switch (strategyName) {
          case 'static': {
            const staticResult = await this.ssgGenerator.generateOnDemandWithContext(url, context);
            result = this.normalizeResult(staticResult, strategyName);
            break;
          }

          case 'cached': {
            const cachedResult = await this.isrModule.serveCached(url, context);
            result = this.normalizeResult(cachedResult, strategyName);
            break;
          }

          case 'regenerate': {
            const regenerateResult = await this.isrModule.regenerate(url, context);
            result = this.normalizeResult(regenerateResult, strategyName);
            break;
          }

          case 'server': {
            // 服务端渲染：调用注入的 renderServer 函数
            if (!this.renderServerFn) {
              throw new Error('renderServerFn 未注入，无法执行服务端渲染');
            }

            console.log('🎯 执行服务端渲染策略...');
            const serverResult = await this.renderServerFn(url, context);
            result = this.normalizeResult(serverResult, strategyName);
            break;
          }

          // CSR(客户端渲染) 策略已被移除
          // case 'client':
          //   const clientResult = await this.csrFallback.render(url, context);
          //   result = this.normalizeResult(clientResult, strategyName);
          //   break;

          default:
            throw new Error(`未知策略: ${strategyName}`);
        }

        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * 获取降级链
   */
  private getFallbackChain(url: string, context: RenderContext): string[] {
    // 用户指定的降级策略
    if (context.requestedFallbackStrategy) {
      return [context.requestedFallbackStrategy];
    }

    // 用户指定的渲染模式
    if (context.requestedRenderMode) {
      return this.getModeChain(context.requestedRenderMode);
    }

    // 路由特定的降级链
    for (const [pattern, chain] of Object.entries(this.config.routeSpecific)) {
      if (this.matchRoute(url, pattern)) {
        return chain;
      }
    }

    // 自适应降级链
    if (this.config.performance.enableAdaptive) {
      const adaptiveChain = this.getAdaptiveChain(url);
      if (adaptiveChain) {
        return adaptiveChain;
      }
    }

    // 默认降级链
    return this.config.defaultChain;
  }

  /**
   * 根据模式获取降级链
   * 注：已移除 CSR(客户端渲染) 降级，确保 SSR/ISR/SSG 的完整性
   */
  private getModeChain(mode: string): string[] {
    switch (mode.toLowerCase()) {
      case 'ssg':
        // SSG 链：静态缓存 → 重新生成 → 失败（无 CSR 降级）
        return ['cached', 'regenerate'];
      case 'isr':
        // ISR 链：缓存命中 → 重新生成 → 服务端渲染 → 失败（无 CSR 降级）
        return ['cached', 'regenerate', 'server'];
      case 'ssr':
        // SSR 链：服务端渲染 → 失败（无 CSR 降级）
        return ['server'];
      case 'csr':
        // CSR 已被移除，返回空数组导致失败（应在上层处理）
        this.logger.warn('❌ 已移除 CSR 降级链，请检查配置');
        return [];
      default:
        // 默认链：不包含 CSR
        return this.config.defaultChain.filter(s => s !== 'client');
    }
  }

  /**
   * 获取自适应降级链
   */
  private getAdaptiveChain(url: string): string[] | null {
    const preferredStrategy = this.adaptiveDecisions.get(url);

    if (preferredStrategy) {
      // 将首选策略放在前面
      const chain = [...this.config.defaultChain];
      const index = chain.indexOf(preferredStrategy);

      if (index > 0) {
        chain.splice(index, 1);
        chain.unshift(preferredStrategy);

        this.logger.debug(`🧠 自适应优化: ${url} 优先使用 ${preferredStrategy}`);
        return chain;
      }
    }

    return null;
  }

  /**
   * 匹配路由模式
   */
  private matchRoute(url: string, pattern: string): boolean {
    // 简单的通配符匹配
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  /**
   * 记录策略成功
   */
  private recordStrategySuccess(strategy: string, responseTime: number): void {
    if (this.config.monitoring.enableDetailedMetrics) {
      // 更新策略健康状态
      this.strategyHealth.set(strategy, true);
    }
  }

  /**
   * 记录策略错误
   */
  private recordStrategyError(strategy: string, error: string, responseTime: number): void {
    if (this.config.monitoring.enableDetailedMetrics) {
      // 记录错误但不立即标记为不健康
      // 将在 shouldMarkUnhealthy 中决定
    }
  }

  /**
   * 判断是否应该标记策略为不健康
   */
  private shouldMarkUnhealthy(strategy: string): boolean {
    const now = Date.now();
    const window = this.config.performance.adaptiveWindow * 1000;

    // 计算时间窗口内的错误率
    const recentErrors = this.errorHistory.filter(
      e => e.strategy === strategy && now - e.timestamp < window
    );

    const recentRequests = this.performanceHistory.filter(
      p => p.strategy === strategy && now - p.timestamp < window
    );

    if (recentRequests.length === 0) return false;

    const errorRate = (recentErrors.length / (recentErrors.length + recentRequests.length)) * 100;

    return errorRate > this.config.performance.errorRateThreshold;
  }

  /**
   * 启动健康检查
   */
  private async startHealthChecks(): Promise<void> {
    this.logger.debug('🏥 启动策略健康检查...');

    for (const strategy of this.config.strategies) {
      if (strategy.healthCheck) {
        const timer = setInterval(async () => {
          try {
            const isHealthy = await strategy.healthCheck!();
            this.strategyHealth.set(strategy.name, isHealthy);

            this.logger.debug(`🏥 健康检查: ${strategy.name} = ${isHealthy ? '✅' : '❌'}`);
          } catch (error) {
            this.strategyHealth.set(strategy.name, false);
            this.logger.debug(`🏥 健康检查失败: ${strategy.name}`, error);
          }
        }, this.config.monitoring.healthCheckInterval);

        this.healthCheckTimers.set(strategy.name, timer);
      }
    }
  }

  /**
   * 启动自适应优化
   */
  private startAdaptiveOptimization(): void {
    this.logger.debug('🧠 启动自适应性能优化...');

    // 每5分钟分析一次性能数据
    setInterval(() => {
      this.analyzePerformanceAndAdapt();
    }, this.config.performance.adaptiveWindow * 1000);
  }

  /**
   * 分析性能并自适应
   */
  private analyzePerformanceAndAdapt(): void {
    const now = Date.now();
    const window = this.config.performance.adaptiveWindow * 1000;

    // 获取时间窗口内的性能数据
    const recentPerformance = this.performanceHistory.filter(p => now - p.timestamp < window);

    if (recentPerformance.length === 0) return;

    // 按策略分组并计算平均响应时间
    const strategyPerformance = new Map<string, number[]>();

    recentPerformance.forEach(p => {
      if (!strategyPerformance.has(p.strategy)) {
        strategyPerformance.set(p.strategy, []);
      }
      strategyPerformance.get(p.strategy)!.push(p.time);
    });

    // 找出每个策略的平均性能
    const avgPerformance = new Map<string, number>();
    strategyPerformance.forEach((times, strategy) => {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      avgPerformance.set(strategy, avg);
    });

    // 找出性能最好的策略
    let bestStrategy = '';
    let bestTime = Infinity;

    avgPerformance.forEach((time, strategy) => {
      if (time < bestTime && this.strategyHealth.get(strategy)) {
        bestTime = time;
        bestStrategy = strategy;
      }
    });

    // 如果找到了更好的策略，更新自适应决策
    if (bestStrategy && bestTime < this.config.performance.performanceThreshold) {
      // 这里可以实现更复杂的逻辑，比如按路由分别优化
      this.adaptiveDecisions.set('*', bestStrategy);

      this.logger.info(
        `🧠 自适应优化: 全局首选策略更新为 ${bestStrategy} (${bestTime.toFixed(2)}ms)`
      );
    }
  }

  /**
   * 清理历史记录
   */
  private cleanupHistory(): void {
    const now = Date.now();
    const maxAge = this.config.performance.adaptiveWindow * 2000; // 保留2倍时间窗口的数据

    // 清理性能历史
    this.performanceHistory = this.performanceHistory.filter(p => now - p.timestamp < maxAge);

    // 清理错误历史
    this.errorHistory = this.errorHistory.filter(e => now - e.timestamp < maxAge);
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取降级链指标
   */
  getMetrics(): FallbackChainMetrics {
    const now = Date.now();
    const window = this.config.performance.adaptiveWindow * 1000;

    // 计算最近的指标
    const recentPerformance = this.performanceHistory.filter(p => now - p.timestamp < window);

    const recentErrors = this.errorHistory.filter(e => now - e.timestamp < window);

    // 策略使用统计
    const strategyUsage: Record<string, number> = {};
    recentPerformance.forEach(p => {
      strategyUsage[p.strategy] = (strategyUsage[p.strategy] || 0) + 1;
    });

    // 错误率统计
    const errorRates: Record<string, number> = {};
    this.config.strategies.forEach(s => {
      const strategyErrors = recentErrors.filter(e => e.strategy === s.name).length;
      const strategyRequests = recentPerformance.filter(p => p.strategy === s.name).length;
      const totalRequests = strategyErrors + strategyRequests;

      errorRates[s.name] = totalRequests > 0 ? (strategyErrors / totalRequests) * 100 : 0;
    });

    // 平均响应时间
    const totalTime = recentPerformance.reduce((sum, p) => sum + p.time, 0);
    const averageResponseTime =
      recentPerformance.length > 0 ? totalTime / recentPerformance.length : 0;

    // 健康检查结果
    const healthCheckResults: Record<string, boolean> = {};
    this.strategyHealth.forEach((healthy, strategy) => {
      healthCheckResults[strategy] = healthy;
    });

    return {
      totalRequests: recentPerformance.length + recentErrors.length,
      successfulFallbacks: recentPerformance.length,
      failedRequests: recentErrors.length,
      strategyUsage,
      averageResponseTime,
      errorRates,
      adaptiveDecisions: this.adaptiveDecisions.size,
      healthCheckResults,
    };
  }

  /**
   * 重置策略健康状态
   */
  resetStrategyHealth(strategy?: string): void {
    if (strategy) {
      this.strategyHealth.set(strategy, true);
      this.logger.info(`🏥 重置策略健康状态: ${strategy}`);
    } else {
      this.config.strategies.forEach(s => {
        this.strategyHealth.set(s.name, true);
      });
      this.logger.info('🏥 重置所有策略健康状态');
    }
  }

  /**
   * 标准化结果格式以符合 RenderResult 接口
   */
  private normalizeResult(result: any, strategyName: string): RenderResult {
    return {
      success: result.success || true,
      html: result.html || '',
      helmet: result.helmet || null,
      preloadLinks: result.preloadLinks || '',
      statusCode: result.statusCode || 200,
      meta: {
        renderMode: result.meta?.renderMode || 'fallback',
        timestamp: result.meta?.timestamp || Date.now(),
        strategy: strategyName,
        fallbackUsed: true,
        skipCache: false,
        fromCache: result.fromCache || false,
        ...result.meta,
      },
    };
  }

  /**
   * 关闭降级链引擎
   */
  async shutdown(): Promise<void> {
    this.logger.debug('🛑 关闭降级链引擎...');

    // 清理健康检查定时器
    this.healthCheckTimers.forEach(timer => {
      clearInterval(timer);
    });
    this.healthCheckTimers.clear();

    // 清理历史记录
    this.performanceHistory = [];
    this.errorHistory = [];
    this.adaptiveDecisions.clear();

    this.logger.debug('✅ 降级链引擎已关闭');
  }
}

/**
 * 工厂函数：创建降级链引擎实例
 */
export function createFallbackChainEngine(
  config: Partial<FallbackChainConfig> = {},
  modules: {
    cache: CacheManager;
    ssgGenerator: SSGGenerator;
    isrModule: ISRModule;
    csrFallback: CSRFallback;
    seoModule: SEOModule;
    metrics: MetricsCollector;
  }
): FallbackChainEngine {
  return new FallbackChainEngine(config, modules);
}
