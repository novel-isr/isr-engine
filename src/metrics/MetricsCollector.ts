/**
 * 运行时性能指标采集器 (Singleton)
 *
 * 跟踪 ISR 引擎的实时性能指标：
 * - 请求计数与响应时间直方图
 * - 缓存命中/未命中率
 * - 按渲染模式分类的统计
 * - 内存使用采样
 *
 * @description 零依赖、无侧效果的纯内存采集器
 * 可被 Prometheus exporter 或 CLI stats 消费
 */

import type { RenderModeType } from '../types';

/** 单次请求记录 */
export interface RequestRecord {
  url: string;
  method: string;
  statusCode: number;
  responseTime: number; // ms
  renderMode: RenderModeType;
  cacheHit: boolean;
  timestamp: number;
}

/** 聚合统计快照 */
export interface MetricsSnapshot {
  /** 服务启动时间 */
  startedAt: number;
  /** 运行时长 (ms) */
  uptime: number;
  /** 请求总数 */
  totalRequests: number;
  /** 成功请求数 (2xx) */
  successRequests: number;
  /** 错误请求数 (4xx/5xx) */
  errorRequests: number;
  /** 成功率 (0-100) */
  successRate: number;
  /** 平均响应时间 (ms) */
  avgResponseTime: number;
  /** P50 响应时间 */
  p50ResponseTime: number;
  /** P95 响应时间 */
  p95ResponseTime: number;
  /** P99 响应时间 */
  p99ResponseTime: number;
  /** 缓存命中率 (0-100) */
  cacheHitRate: number;
  /** 按渲染模式分类的请求计数 */
  renderModeBreakdown: Record<string, number>;
  /** 当前内存使用 (MB) */
  memoryUsageMB: number;
  /** 当前堆使用 (MB) */
  heapUsedMB: number;
}

/** 滑动窗口大小 (保留最近 N 条请求记录用于百分位计算) */
const WINDOW_SIZE = 10_000;

export class MetricsCollector {
  private static instance: MetricsCollector;

  private startedAt: number = Date.now();
  private totalRequests = 0;
  private successRequests = 0;
  private errorRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalResponseTime = 0;
  private renderModeBreakdown: Record<string, number> = {};

  /** 滑动窗口：用于计算百分位 */
  private recentResponseTimes: number[] = [];

  // 仅通过 getInstance 拿到实例 —— 单例语义，私有构造禁止外部 new
  private constructor() {
    /* singleton */
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * 重置所有指标 (用于测试)
   */
  reset(): void {
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.successRequests = 0;
    this.errorRequests = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalResponseTime = 0;
    this.renderModeBreakdown = {};
    this.recentResponseTimes = [];
  }

  /**
   * 记录一次请求
   */
  record(record: RequestRecord): void {
    this.totalRequests++;
    this.totalResponseTime += record.responseTime;

    if (record.statusCode >= 200 && record.statusCode < 400) {
      this.successRequests++;
    } else {
      this.errorRequests++;
    }

    if (record.cacheHit) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }

    // 渲染模式计数
    const mode = record.renderMode || 'unknown';
    this.renderModeBreakdown[mode] = (this.renderModeBreakdown[mode] || 0) + 1;

    // 滑动窗口
    this.recentResponseTimes.push(record.responseTime);
    if (this.recentResponseTimes.length > WINDOW_SIZE) {
      this.recentResponseTimes.shift();
    }
  }

  /**
   * 获取当前指标快照
   */
  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    const memUsage = process.memoryUsage();

    // 排序后计算百分位
    const sorted = [...this.recentResponseTimes].sort((a, b) => a - b);

    return {
      startedAt: this.startedAt,
      uptime: now - this.startedAt,
      totalRequests: this.totalRequests,
      successRequests: this.successRequests,
      errorRequests: this.errorRequests,
      successRate:
        this.totalRequests > 0
          ? Number(((this.successRequests / this.totalRequests) * 100).toFixed(1))
          : 0,
      avgResponseTime:
        this.totalRequests > 0 ? Math.round(this.totalResponseTime / this.totalRequests) : 0,
      p50ResponseTime: this.percentile(sorted, 0.5),
      p95ResponseTime: this.percentile(sorted, 0.95),
      p99ResponseTime: this.percentile(sorted, 0.99),
      cacheHitRate:
        this.cacheHits + this.cacheMisses > 0
          ? Number(((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100).toFixed(1))
          : 0,
      renderModeBreakdown: { ...this.renderModeBreakdown },
      memoryUsageMB: Number((memUsage.rss / (1024 * 1024)).toFixed(1)),
      heapUsedMB: Number((memUsage.heapUsed / (1024 * 1024)).toFixed(1)),
    };
  }

  /**
   * 计算百分位值
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * 返回 JSON 格式的指标 (可用于 /metrics API 端点)
   */
  toJSON(): MetricsSnapshot {
    return this.getSnapshot();
  }
}
