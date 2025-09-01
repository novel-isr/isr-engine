/**
 * 精确的指标统计收集器
 * 用于收集ISR引擎的性能指标和统计数据
 */
export interface RenderMetrics {
  url: string;
  mode: 'isr' | 'ssr' | 'ssg' | 'csr';
  strategy: 'cached' | 'regenerate' | 'server' | 'static' | 'client';
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  error?: string;
  statusCode: number;
  contentLength: number;
  fromCache: boolean;
  cacheAge?: number;
  concurrent: boolean;
  userAgent?: string;
  timestamp: number;
}

export interface CacheMetrics {
  url: string;
  action: 'hit' | 'miss' | 'regenerate' | 'evict';
  cacheAge?: number;
  contentLength: number;
  timestamp: number;
}

export interface SystemMetrics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage?: NodeJS.CpuUsage;
  activeConnections: number;
  queueLength: number;
  timestamp: number;
}

export class MetricsCollector {
  private renderMetrics: RenderMetrics[] = [];
  private cacheMetrics: CacheMetrics[] = [];
  private systemMetrics: SystemMetrics[] = [];

  // 实时统计
  private stats = {
    // 渲染统计
    totalRequests: 0,
    successfulRenders: 0,
    failedRenders: 0,

    // 策略统计
    isrCacheHits: 0,
    isrRegenerations: 0,
    ssrRenders: 0,
    ssgServes: 0,
    csrFallbacks: 0,

    // 性能统计
    totalRenderTime: 0,
    averageRenderTime: 0,
    maxRenderTime: 0,
    minRenderTime: Infinity,

    // 缓存统计
    cacheHitRate: 0,
    totalCacheSize: 0,

    // 并发统计
    maxConcurrentRequests: 0,
    currentConcurrentRequests: 0,

    // 错误统计
    timeoutErrors: 0,
    renderErrors: 0,
    cacheErrors: 0,
  };

  private maxMetricsHistory = 10000; // 保留最近10000条记录
  private metricsStartTime = Date.now();

  /**
   * 记录渲染指标
   */
  recordRender(metrics: RenderMetrics): void {
    this.renderMetrics.push(metrics);
    this.trimMetrics();
    this.updateRenderStats(metrics);
  }

  /**
   * 记录缓存指标
   */
  recordCache(metrics: CacheMetrics): void {
    this.cacheMetrics.push(metrics);
    this.trimMetrics();
    this.updateCacheStats(metrics);
  }

  /**
   * 记录系统指标
   */
  recordSystem(metrics: SystemMetrics): void {
    this.systemMetrics.push(metrics);
    this.trimMetrics();
    this.updateSystemStats(metrics);
  }

  /**
   * 开始渲染计时
   */
  startRender(url: string, mode: string, strategy: string): string {
    const id = `${url}-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();

    this.stats.currentConcurrentRequests++;
    this.stats.maxConcurrentRequests = Math.max(
      this.stats.maxConcurrentRequests,
      this.stats.currentConcurrentRequests
    );

    return id;
  }

  /**
   * 结束渲染计时
   */
  endRender(
    id: string,
    url: string,
    mode: 'isr' | 'ssr' | 'ssg' | 'csr',
    strategy: 'cached' | 'regenerate' | 'server' | 'static' | 'client',
    startTime: number,
    success: boolean,
    statusCode: number,
    contentLength: number,
    fromCache: boolean,
    error?: string,
    cacheAge?: number,
    userAgent?: string
  ): void {
    const endTime = Date.now();
    const duration = endTime - startTime;

    this.stats.currentConcurrentRequests--;

    const metrics: RenderMetrics = {
      url,
      mode,
      strategy,
      startTime,
      endTime,
      duration,
      success,
      error,
      statusCode,
      contentLength,
      fromCache,
      cacheAge,
      concurrent: this.stats.currentConcurrentRequests > 0,
      userAgent,
      timestamp: endTime,
    };

    this.recordRender(metrics);
  }

  /**
   * 获取实时统计
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.metricsStartTime,
      cacheHitRate:
        this.stats.totalRequests > 0
          ? ((this.stats.isrCacheHits / this.stats.totalRequests) * 100).toFixed(2) + '%'
          : '0%',
      successRate:
        this.stats.totalRequests > 0
          ? ((this.stats.successfulRenders / this.stats.totalRequests) * 100).toFixed(2) + '%'
          : '0%',
      averageRenderTime:
        this.stats.totalRequests > 0
          ? Math.round(this.stats.totalRenderTime / this.stats.totalRequests)
          : 0,
    };
  }

  /**
   * 获取详细指标报告
   */
  getDetailedReport() {
    const now = Date.now();
    const last5min = now - 5 * 60 * 1000;
    const last1hour = now - 60 * 60 * 1000;

    const recent5min = this.renderMetrics.filter(m => m.timestamp > last5min);
    const recent1hour = this.renderMetrics.filter(m => m.timestamp > last1hour);

    return {
      overview: this.getStats(),
      recent: {
        last5Minutes: this.calculatePeriodStats(recent5min),
        lastHour: this.calculatePeriodStats(recent1hour),
      },
      performance: {
        p50: this.calculatePercentile(
          this.renderMetrics.map(m => m.duration),
          50
        ),
        p90: this.calculatePercentile(
          this.renderMetrics.map(m => m.duration),
          90
        ),
        p99: this.calculatePercentile(
          this.renderMetrics.map(m => m.duration),
          99
        ),
      },
      errors: this.getErrorAnalysis(),
      cache: this.getCacheAnalysis(),
    };
  }

  /**
   * 获取性能趋势数据
   */
  getPerformanceTrends(intervalMinutes: number = 5) {
    const now = Date.now();
    const interval = intervalMinutes * 60 * 1000;
    const trends = [];

    for (let i = 0; i < 12; i++) {
      // 最近12个时间段
      const endTime = now - i * interval;
      const startTime = endTime - interval;

      const periodMetrics = this.renderMetrics.filter(
        m => m.timestamp >= startTime && m.timestamp < endTime
      );

      trends.unshift({
        period: new Date(startTime).toISOString(),
        requests: periodMetrics.length,
        averageTime:
          periodMetrics.length > 0
            ? Math.round(
                periodMetrics.reduce((sum, m) => sum + m.duration, 0) / periodMetrics.length
              )
            : 0,
        successRate:
          periodMetrics.length > 0
            ? ((periodMetrics.filter(m => m.success).length / periodMetrics.length) * 100).toFixed(
                1
              )
            : '0',
        cacheHitRate:
          periodMetrics.length > 0
            ? (
                (periodMetrics.filter(m => m.fromCache).length / periodMetrics.length) *
                100
              ).toFixed(1)
            : '0',
      });
    }

    return trends;
  }

  private updateRenderStats(metrics: RenderMetrics): void {
    this.stats.totalRequests++;

    if (metrics.success) {
      this.stats.successfulRenders++;
    } else {
      this.stats.failedRenders++;
      if (metrics.error?.includes('超时')) {
        this.stats.timeoutErrors++;
      } else {
        this.stats.renderErrors++;
      }
    }

    // 策略统计
    switch (metrics.strategy) {
      case 'cached':
        this.stats.isrCacheHits++;
        break;
      case 'regenerate':
        this.stats.isrRegenerations++;
        break;
      case 'server':
        this.stats.ssrRenders++;
        break;
      case 'static':
        this.stats.ssgServes++;
        break;
      case 'client':
        this.stats.csrFallbacks++;
        break;
    }

    // 性能统计
    this.stats.totalRenderTime += metrics.duration;
    this.stats.maxRenderTime = Math.max(this.stats.maxRenderTime, metrics.duration);
    this.stats.minRenderTime = Math.min(this.stats.minRenderTime, metrics.duration);
    this.stats.averageRenderTime = this.stats.totalRenderTime / this.stats.totalRequests;
  }

  private updateCacheStats(metrics: CacheMetrics): void {
    // 缓存统计更新逻辑
  }

  private updateSystemStats(metrics: SystemMetrics): void {
    // 系统统计更新逻辑
  }

  private trimMetrics(): void {
    if (this.renderMetrics.length > this.maxMetricsHistory) {
      this.renderMetrics = this.renderMetrics.slice(-this.maxMetricsHistory);
    }
    if (this.cacheMetrics.length > this.maxMetricsHistory) {
      this.cacheMetrics = this.cacheMetrics.slice(-this.maxMetricsHistory);
    }
    if (this.systemMetrics.length > this.maxMetricsHistory) {
      this.systemMetrics = this.systemMetrics.slice(-this.maxMetricsHistory);
    }
  }

  private calculatePeriodStats(metrics: RenderMetrics[]) {
    if (metrics.length === 0) {
      return {
        requests: 0,
        successRate: '0%',
        averageTime: 0,
        cacheHitRate: '0%',
      };
    }

    const successful = metrics.filter(m => m.success).length;
    const cached = metrics.filter(m => m.fromCache).length;
    const totalTime = metrics.reduce((sum, m) => sum + m.duration, 0);

    return {
      requests: metrics.length,
      successRate: ((successful / metrics.length) * 100).toFixed(1) + '%',
      averageTime: Math.round(totalTime / metrics.length),
      cacheHitRate: ((cached / metrics.length) * 100).toFixed(1) + '%',
    };
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;

    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }

  private getErrorAnalysis() {
    const errors = this.renderMetrics.filter(m => !m.success);
    const errorTypes = new Map<string, number>();

    errors.forEach(error => {
      const type = error.error || 'Unknown';
      errorTypes.set(type, (errorTypes.get(type) || 0) + 1);
    });

    return {
      total: errors.length,
      types: Object.fromEntries(errorTypes),
      recent: errors.filter(e => e.timestamp > Date.now() - 60 * 60 * 1000).length,
    };
  }

  private getCacheAnalysis() {
    const cacheMetrics = this.cacheMetrics;
    const hits = cacheMetrics.filter(m => m.action === 'hit').length;
    const misses = cacheMetrics.filter(m => m.action === 'miss').length;
    const regenerations = cacheMetrics.filter(m => m.action === 'regenerate').length;

    return {
      hitRate: hits + misses > 0 ? ((hits / (hits + misses)) * 100).toFixed(2) + '%' : '0%',
      totalHits: hits,
      totalMisses: misses,
      regenerations,
      averageCacheAge: this.calculateAverageCacheAge(),
    };
  }

  private calculateAverageCacheAge(): number {
    const withAge = this.cacheMetrics.filter(m => m.cacheAge !== undefined);
    if (withAge.length === 0) return 0;

    const totalAge = withAge.reduce((sum, m) => sum + (m.cacheAge || 0), 0);
    return Math.round(totalAge / withAge.length / 1000); // 转换为秒
  }

  /**
   * 重置统计数据
   */
  reset(): void {
    this.renderMetrics = [];
    this.cacheMetrics = [];
    this.systemMetrics = [];
    this.stats = {
      totalRequests: 0,
      successfulRenders: 0,
      failedRenders: 0,
      isrCacheHits: 0,
      isrRegenerations: 0,
      ssrRenders: 0,
      ssgServes: 0,
      csrFallbacks: 0,
      totalRenderTime: 0,
      averageRenderTime: 0,
      maxRenderTime: 0,
      minRenderTime: Infinity,
      cacheHitRate: 0,
      totalCacheSize: 0,
      maxConcurrentRequests: 0,
      currentConcurrentRequests: 0,
      timeoutErrors: 0,
      renderErrors: 0,
      cacheErrors: 0,
    };
    this.metricsStartTime = Date.now();
  }
}
