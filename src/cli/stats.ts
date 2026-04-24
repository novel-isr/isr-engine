/**
 * 性能统计命令
 *
 * 从运行中的 ISR 引擎获取真实性能指标：
 * - 连接本地 metrics HTTP 端点 (默认 /__isr_metrics)
 * - 或读取 MetricsCollector 的共享内存快照
 */

import { logger } from '@/logger';
import type { MetricsSnapshot } from '@/metrics';
import { loadConfig } from '../config/loadConfig';
import type { ISRConfig } from '@/types';

export interface StatsOptions {
  watch: boolean;
  detailed: boolean;
  format?: string;
  port?: string | number;
  host?: string;
}

function resolveMetricsUrl(options: StatsOptions, config: ISRConfig): string | null {
  const port =
    typeof options.port === 'string'
      ? parseInt(options.port)
      : typeof options.port === 'number'
        ? options.port
        : config.server?.port || (process.env.PORT ? parseInt(process.env.PORT) : 3000);

  const host = options.host || config.server?.host || process.env.ISR_HOST || process.env.HOST;
  if (!host) {
    return null;
  }

  const protocol = config.server?.ssl || config.server?.protocol === 'https' ? 'https' : 'http';
  return `${protocol}://${host}:${port}/__isr_metrics`;
}

/**
 * 格式化运行时长
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export async function showStats(options: StatsOptions) {
  const { watch, detailed } = options;
  const config = await loadConfig();

  const metricsUrl = resolveMetricsUrl(options, config);
  if (!metricsUrl) {
    logger.warn(
      '[Stats]',
      '未配置 metrics 访问地址。请使用 --host/--port 或在配置中设置 server.host/server.port'
    );
    return;
  }

  logger.info('[Stats]', '性能统计信息');

  if (watch) {
    logger.warn('[Stats]', '实时监控模式 (按 Ctrl+C 退出)');

    const updateStats = async () => {
      try {
        console.clear();
        logger.info('[Stats]', '实时性能监控');
        logger.info('[Stats]', `更新时间: ${new Date().toLocaleTimeString()}`);
        await displayStats(detailed, metricsUrl);
        setTimeout(updateStats, 5000);
      } catch (error) {
        logger.error('[Stats]', '获取统计信息失败', error);
      }
    };

    updateStats();
  } else {
    await displayStats(detailed, metricsUrl);
  }
}

async function fetchMetricsByUrl(metricsUrl: string): Promise<MetricsSnapshot | null> {
  try {
    const response = await fetch(metricsUrl);
    if (!response.ok) return null;
    return (await response.json()) as MetricsSnapshot;
  } catch {
    return null;
  }
}

async function displayStats(detailed: boolean, metricsUrl: string) {
  const snapshot = await fetchMetricsByUrl(metricsUrl);

  if (!snapshot) {
    logger.warn('[Stats]', `⚠️ 无法连接到 ISR 服务器 metrics: ${metricsUrl}`);
    logger.warn('[Stats]', '请确保服务器正在运行 (novel-isr start)');
    logger.warn('[Stats]', '服务器需要启用 metrics 端点: GET /__isr_metrics');
    return;
  }

  // 核心指标
  logger.info('[Stats]', '核心指标:');
  logger.info('[Stats]', `运行时长: ${formatUptime(snapshot.uptime)}`);
  logger.info('[Stats]', `请求总数: ${snapshot.totalRequests.toLocaleString()}`);
  logger.info('[Stats]', `平均响应时间: ${snapshot.avgResponseTime}ms`);
  logger.info('[Stats]', `成功率: ${snapshot.successRate}%`);
  logger.info('[Stats]', `缓存命中率: ${snapshot.cacheHitRate}%`);

  if (detailed) {
    // 响应时间百分位
    logger.info('[Stats]', '响应时间分布:');
    logger.info('[Stats]', `  P50: ${snapshot.p50ResponseTime}ms`);
    logger.info('[Stats]', `  P95: ${snapshot.p95ResponseTime}ms`);
    logger.info('[Stats]', `  P99: ${snapshot.p99ResponseTime}ms`);

    // 渲染模式分布
    logger.info('[Stats]', '渲染模式分布:');
    for (const [mode, count] of Object.entries(snapshot.renderModeBreakdown)) {
      const percentage =
        snapshot.totalRequests > 0 ? ((count / snapshot.totalRequests) * 100).toFixed(1) : '0';
      logger.info('[Stats]', `  ${mode.toUpperCase()}: ${count.toLocaleString()} (${percentage}%)`);
    }

    // 系统资源
    logger.info('[Stats]', '系统资源:');
    logger.info('[Stats]', `  内存使用: ${snapshot.memoryUsageMB}MB`);
    logger.info('[Stats]', `  堆内存: ${snapshot.heapUsedMB}MB`);
  }
}
