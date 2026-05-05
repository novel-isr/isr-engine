/**
 * 性能统计命令
 *
 * 从运行中的 ISR 引擎获取真实性能指标：
 * - 连接本地 ISR stats JSON 端点 (默认 /__isr/stats)
 * - Prometheus 指标请直接抓取 /metrics
 */

import { logger } from '@/logger';
import { loadConfig } from '../config/loadConfig';
import type { ISRConfig } from '@/types';

interface IsrStatsSnapshot {
  size: number;
  max: number;
  revalidating: number;
  backend: 'memory' | 'hybrid';
}

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

  return `http://${host}:${port}/__isr/stats`;
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

async function fetchMetricsByUrl(metricsUrl: string): Promise<IsrStatsSnapshot | null> {
  try {
    const response = await fetch(metricsUrl);
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<IsrStatsSnapshot>;
    if (
      typeof json.size !== 'number' ||
      typeof json.max !== 'number' ||
      typeof json.revalidating !== 'number' ||
      (json.backend !== 'memory' && json.backend !== 'hybrid')
    ) {
      return null;
    }
    return json as IsrStatsSnapshot;
  } catch {
    return null;
  }
}

async function displayStats(detailed: boolean, metricsUrl: string) {
  const snapshot = await fetchMetricsByUrl(metricsUrl);

  if (!snapshot) {
    logger.warn('[Stats]', `⚠️ 无法连接到 ISR 服务器 metrics: ${metricsUrl}`);
    logger.warn('[Stats]', '请确保服务器正在运行 (novel-isr start)');
    logger.warn('[Stats]', '服务器需要启用 stats 端点: GET /__isr/stats');
    return;
  }

  logger.info('[Stats]', 'ISR 缓存指标:');
  logger.info('[Stats]', `缓存后端: ${snapshot.backend}`);
  logger.info('[Stats]', `缓存条目: ${snapshot.size}/${snapshot.max}`);
  logger.info('[Stats]', `后台重生中: ${snapshot.revalidating}`);

  if (detailed) {
    logger.info('[Stats]', `Prometheus 指标: ${metricsUrl.replace('/__isr/stats', '/metrics')}`);
  }
}
