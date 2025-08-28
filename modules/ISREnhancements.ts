/**
 * ISR引擎增强功能
 * 提供智能重试、优雅降级、资源管理等企业级功能
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';
import { globalErrorHandler, ErrorType, ErrorSeverity } from '../utils/ErrorHandler';

export interface ISRQueueItem {
  url: string;
  priority: number;
  retryCount: number;
  maxRetries: number;
  context: any;
  timestamp: number;
  deadline?: number;
}

export interface ISRMetrics {
  regenerations: number;
  backgroundJobs: number;
  queueLength: number;
  avgProcessingTime: number;
  errorRate: number;
  cacheHitRate: number;
  lastActivity: number;
}

export interface ISRHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    queueHealth: boolean;
    memoryUsage: boolean;
    errorRate: boolean;
    diskSpace: boolean;
  };
  metrics: ISRMetrics;
  recommendations: string[];
}

/**
 * ISR任务队列管理器
 */
export class ISRQueue extends EventEmitter {
  private queue: ISRQueueItem[] = [];
  private processing = false;
  private maxQueueSize: number;
  private maxConcurrentJobs: number;
  private currentJobs = 0;
  private logger: Logger;
  private metrics: ISRMetrics;

  constructor(config: { maxQueueSize?: number; maxConcurrentJobs?: number; verbose?: boolean }) {
    super();
    this.maxQueueSize = config.maxQueueSize || 1000;
    this.maxConcurrentJobs = config.maxConcurrentJobs || 3;
    this.logger = new Logger(config.verbose);
    this.metrics = {
      regenerations: 0,
      backgroundJobs: 0,
      queueLength: 0,
      avgProcessingTime: 0,
      errorRate: 0,
      cacheHitRate: 0,
      lastActivity: Date.now(),
    };
  }

  async enqueue(item: Omit<ISRQueueItem, 'timestamp'>): Promise<boolean> {
    if (this.queue.length >= this.maxQueueSize) {
      this.logger.warn(`ISR队列已满，丢弃低优先级任务: ${item.url}`);
      this.evictLowPriorityItems();
      
      if (this.queue.length >= this.maxQueueSize) {
        return false; // 仍然满，拒绝任务
      }
    }

    // 检查是否已存在相同URL的任务
    const existingIndex = this.queue.findIndex(queueItem => queueItem.url === item.url);
    if (existingIndex >= 0) {
      // 更新现有任务的优先级和重试次数
      const existing = this.queue[existingIndex];
      existing.priority = Math.max(existing.priority, item.priority);
      existing.retryCount = 0; // 重置重试次数
      existing.timestamp = Date.now();
      this.logger.debug(`更新已存在的ISR任务: ${item.url}`);
      return true;
    }

    const queueItem: ISRQueueItem = {
      ...item,
      timestamp: Date.now(),
    };

    this.queue.push(queueItem);
    this.queue.sort((a, b) => b.priority - a.priority); // 按优先级排序
    
    this.metrics.queueLength = this.queue.length;
    this.emit('enqueue', queueItem);
    
    if (!this.processing) {
      this.startProcessing();
    }

    return true;
  }

  private evictLowPriorityItems(): void {
    // 移除最低优先级的10%任务
    const evictCount = Math.ceil(this.queue.length * 0.1);
    this.queue.sort((a, b) => a.priority - b.priority); // 升序，低优先级在前
    const evicted = this.queue.splice(0, evictCount);
    
    this.logger.debug(`清理${evicted.length}个低优先级ISR任务`);
    evicted.forEach(item => this.emit('evicted', item));
  }

  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    
    this.processing = true;
    this.logger.debug('开始处理ISR队列');

    while (this.queue.length > 0 && this.currentJobs < this.maxConcurrentJobs) {
      const item = this.queue.shift();
      if (!item) break;

      this.metrics.queueLength = this.queue.length;
      this.currentJobs++;
      
      // 异步处理任务
      this.processItem(item).finally(() => {
        this.currentJobs--;
      });
    }

    // 如果没有更多任务或达到并发限制，停止处理循环
    if (this.queue.length === 0 || this.currentJobs >= this.maxConcurrentJobs) {
      this.processing = false;
    }

    // 如果还有任务且有空闲槽位，继续处理
    if (this.queue.length > 0 && this.currentJobs < this.maxConcurrentJobs) {
      setTimeout(() => this.startProcessing(), 100);
    }
  }

  private async processItem(item: ISRQueueItem): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.logger.debug(`处理ISR任务: ${item.url} (优先级: ${item.priority})`);
      
      // 检查任务是否过期
      if (item.deadline && Date.now() > item.deadline) {
        this.logger.warn(`ISR任务已过期，跳过: ${item.url}`);
        this.emit('expired', item);
        return;
      }

      this.metrics.backgroundJobs++;
      this.emit('processing', item);
      
      // 这里应该调用实际的ISR重新生成逻辑
      // 由于ISRModule的regenerate方法是私有的，我们通过事件系统调用
      await new Promise((resolve, reject) => {
        this.emit('regenerate', item, resolve, reject);
      });

      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, true);
      
      this.logger.debug(`ISR任务完成: ${item.url} (耗时: ${processingTime}ms)`);
      this.emit('completed', item, processingTime);
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, false);
      
      this.logger.error(`ISR任务失败: ${item.url}`, error);
      
      // 重试逻辑
      if (item.retryCount < item.maxRetries) {
        item.retryCount++;
        item.priority = Math.max(1, item.priority - 1); // 降低优先级
        
        const retryDelay = Math.min(1000 * Math.pow(2, item.retryCount), 60000); // 指数退避，最大60秒
        setTimeout(() => {
          this.queue.push(item);
          this.queue.sort((a, b) => b.priority - a.priority);
          this.logger.debug(`ISR任务将重试: ${item.url} (第${item.retryCount}/${item.maxRetries}次)`);
        }, retryDelay);
      } else {
        this.emit('failed', item, error);
      }
    }
  }

  private updateMetrics(processingTime: number, success: boolean): void {
    this.metrics.regenerations++;
    this.metrics.lastActivity = Date.now();
    
    // 更新平均处理时间（简单移动平均）
    const alpha = 0.1; // 平滑因子
    this.metrics.avgProcessingTime = 
      this.metrics.avgProcessingTime * (1 - alpha) + processingTime * alpha;
    
    // 更新错误率
    if (!success) {
      this.metrics.errorRate = Math.min(this.metrics.errorRate * 0.95 + 0.05, 1.0);
    } else {
      this.metrics.errorRate = Math.max(this.metrics.errorRate * 0.99, 0.0);
    }
  }

  getMetrics(): ISRMetrics {
    return { ...this.metrics, queueLength: this.queue.length };
  }

  getQueueStatus() {
    return {
      length: this.queue.length,
      processing: this.processing,
      currentJobs: this.currentJobs,
      maxJobs: this.maxConcurrentJobs,
      nextItems: this.queue.slice(0, 5).map(item => ({
        url: item.url,
        priority: item.priority,
        retryCount: item.retryCount,
        age: Date.now() - item.timestamp,
      })),
    };
  }

  clear(): void {
    this.queue.length = 0;
    this.metrics.queueLength = 0;
    this.logger.info('ISR队列已清空');
    this.emit('cleared');
  }

  pause(): void {
    this.processing = false;
    this.logger.info('ISR队列已暂停');
    this.emit('paused');
  }

  resume(): void {
    if (!this.processing && this.queue.length > 0) {
      this.startProcessing();
      this.logger.info('ISR队列已恢复');
      this.emit('resumed');
    }
  }
}

/**
 * ISR资源监控器
 */
export class ISRResourceMonitor {
  private logger: Logger;
  private config: {
    maxMemoryUsage: number; // MB
    maxDiskUsage: number; // %
    maxCpuUsage: number; // %
    checkInterval: number; // ms
  };
  private monitoringInterval?: NodeJS.Timeout;
  private resourceStats: any = {};

  constructor(config: Partial<typeof ISRResourceMonitor.prototype.config> & { verbose?: boolean }) {
    this.logger = new Logger(config.verbose);
    this.config = {
      maxMemoryUsage: config.maxMemoryUsage || 512, // 512MB
      maxDiskUsage: config.maxDiskUsage || 90, // 90%
      maxCpuUsage: config.maxCpuUsage || 80, // 80%
      checkInterval: config.checkInterval || 30000, // 30秒
    };
  }

  startMonitoring(): void {
    if (this.monitoringInterval) {
      this.stopMonitoring();
    }

    this.monitoringInterval = setInterval(() => {
      this.checkResources();
    }, this.config.checkInterval);

    this.logger.info('ISR资源监控已启动');
  }

  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      this.logger.info('ISR资源监控已停止');
    }
  }

  private async checkResources(): Promise<void> {
    try {
      // 检查内存使用
      const memoryUsage = process.memoryUsage();
      const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
      const heapTotalMB = memoryUsage.heapTotal / 1024 / 1024;

      // 检查磁盘使用（简化版）
      const diskUsage = await this.getDiskUsage();

      // 更新统计
      this.resourceStats = {
        memory: {
          heapUsed: Math.round(heapUsedMB),
          heapTotal: Math.round(heapTotalMB),
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          external: Math.round(memoryUsage.external / 1024 / 1024),
        },
        disk: diskUsage,
        timestamp: Date.now(),
      };

      // 检查阈值
      if (heapUsedMB > this.config.maxMemoryUsage) {
        this.logger.warn(`内存使用过高: ${Math.round(heapUsedMB)}MB > ${this.config.maxMemoryUsage}MB`);
        this.triggerCleanup('memory');
      }

      if (diskUsage.usage > this.config.maxDiskUsage) {
        this.logger.warn(`磁盘使用过高: ${diskUsage.usage}% > ${this.config.maxDiskUsage}%`);
        this.triggerCleanup('disk');
      }

    } catch (error) {
      this.logger.error('资源检查失败:', error);
    }
  }

  private async getDiskUsage(): Promise<{ usage: number; available: number; total: number }> {
    try {
      const fs = await import('fs');
      const stats = await fs.promises.statfs(process.cwd());
      
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      const used = total - available;
      
      return {
        usage: Math.round((used / total) * 100),
        available: Math.round(available / 1024 / 1024 / 1024), // GB
        total: Math.round(total / 1024 / 1024 / 1024), // GB
      };
    } catch (error) {
      // fallback for environments where statfs is not available
      return { usage: 0, available: 0, total: 0 };
    }
  }

  private triggerCleanup(reason: string): void {
    this.logger.info(`触发资源清理，原因: ${reason}`);
    
    // 触发垃圾回收
    if (global.gc) {
      global.gc();
      this.logger.debug('强制垃圾回收');
    }
    
    // 发送事件让其他组件处理清理
    (process as any).emit('isr:resource-pressure', {
      reason,
      stats: this.resourceStats,
    });
  }

  getResourceStats() {
    return this.resourceStats;
  }
}

/**
 * ISR健康检查器
 */
export class ISRHealthChecker {
  private queue: ISRQueue;
  private monitor: ISRResourceMonitor;
  private logger: Logger;

  constructor(queue: ISRQueue, monitor: ISRResourceMonitor, verbose = false) {
    this.queue = queue;
    this.monitor = monitor;
    this.logger = new Logger(verbose);
  }

  async getHealthStatus(): Promise<ISRHealthStatus> {
    const metrics = this.queue.getMetrics();
    const queueStatus = this.queue.getQueueStatus();
    const resourceStats = this.monitor.getResourceStats();

    // 健康检查
    const checks = {
      queueHealth: queueStatus.length < 100 && metrics.errorRate < 0.1,
      memoryUsage: !resourceStats.memory || resourceStats.memory.heapUsed < 400,
      errorRate: metrics.errorRate < 0.05,
      diskSpace: !resourceStats.disk || resourceStats.disk.usage < 85,
    };

    const healthyChecks = Object.values(checks).filter(Boolean).length;
    const totalChecks = Object.values(checks).length;

    let status: ISRHealthStatus['status'];
    if (healthyChecks === totalChecks) {
      status = 'healthy';
    } else if (healthyChecks >= totalChecks * 0.75) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    // 生成建议
    const recommendations: string[] = [];
    if (!checks.queueHealth) {
      recommendations.push('队列积压严重，考虑增加并发处理数或优化处理逻辑');
    }
    if (!checks.memoryUsage) {
      recommendations.push('内存使用过高，建议重启应用或增加内存限制');
    }
    if (!checks.errorRate) {
      recommendations.push('错误率过高，检查网络连接和渲染逻辑');
    }
    if (!checks.diskSpace) {
      recommendations.push('磁盘空间不足，清理缓存文件或扩展磁盘');
    }

    return {
      status,
      checks,
      metrics,
      recommendations,
    };
  }

  async performHealthCheck(): Promise<boolean> {
    const health = await this.getHealthStatus();
    
    if (health.status === 'unhealthy') {
      this.logger.error('ISR引擎健康状况不佳:', {
        status: health.status,
        failedChecks: Object.entries(health.checks)
          .filter(([, passed]) => !passed)
          .map(([check]) => check),
        recommendations: health.recommendations,
      });
      return false;
    }

    if (health.status === 'degraded') {
      this.logger.warn('ISR引擎性能下降:', {
        status: health.status,
        recommendations: health.recommendations,
      });
    }

    return true;
  }
}

// Classes are already exported above, no need for duplicate exports