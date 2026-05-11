/**
 * ExposureQueue —— 曝光事件批量上报队列
 *
 * 设计取舍：
 *   - **fire-and-forget**：业务渲染路径 push() 完立刻返回，不等任何 IO
 *   - **批量 flush**：减小 admin-server QPS（默认 100 条 / 1s 攒一批）
 *   - **不去重**：写入全量；分析期 COUNT(DISTINCT anon_id) 解（业界惯例，
 *     GrowthBook / Statsig / LinkedIn LiX 同款）
 *   - **不阻塞退出**：进程收到 SIGTERM 时同步 flush 一次最后批次再退出
 *   - **失败丢弃 + 警告日志**：业务不应该感知 exposure 失败
 *   - **采样**：sampleRate < 1 时随机丢弃，高 QPS 场景控制 admin-server 负载
 *
 * 不在本模块的事：
 *   - HTTP retry / backoff 走 fetch + 短暂 retry，admin-server 全挂时丢这一批
 *   - dedupe（写期不做）
 *   - schema 校验（admin-server 那边做）
 */
import { Logger } from '../logger/Logger';
import type { RuntimeExperimentTrackingConfig } from '../types/ISRConfig';

const logger = Logger.getInstance();

export interface ExposureEvent {
  /** 浏览器 / 设备稳定 UUID */
  anonId: string;
  /** 已登录用户 ID（业务侧 beforeRequest 写入） */
  userId: string | null;
  /** 本次请求 ID，关联 engine trace */
  requestId: string;
  /** 本次 SSR 涉及的全部实验：{ 'hero-style': 'bold', 'pricing-cta': 'discount' } */
  experiments: Record<string, string>;
  /** 请求 path（不含 query）；用于按页面切实验数据 */
  path: string;
  /** 时间戳（ms epoch）—— engine 生成时刻 */
  ts: number;
}

export interface ExposureQueueOptions {
  /** admin-server endpoint（绝对 URL；engine 入口负责把相对路径拼好后传进来） */
  endpoint: string;
  /** 单批最大事件数；默认 100 */
  batchSize?: number;
  /** 距上次 flush 多久强制 flush（ms）；默认 1000 */
  flushIntervalMs?: number;
  /** 采样率 [0, 1]；默认 1.0；高 QPS 时降到 0.1 / 0.01 */
  sampleRate?: number;
  /** 队列硬上限（防止 admin-server 长宕时内存爆）；默认 batchSize × 2 */
  maxQueueSize?: number;
  /** 自定义 fetch（测试用）；默认 globalThis.fetch */
  fetcher?: typeof fetch;
}

interface QueueState {
  events: ExposureEvent[];
  flushTimer: NodeJS.Timeout | null;
  destroyed: boolean;
}

/**
 * 创建上报队列。同一进程整个 lifecycle 只创建一个；engine 入口保管 instance。
 * 返回 push() / flush() / destroy() 三个方法。
 */
export function createExposureQueue(options: ExposureQueueOptions) {
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const sampleRate = options.sampleRate ?? 1.0;
  const maxQueueSize = options.maxQueueSize ?? batchSize * 2;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = options.endpoint;

  const state: QueueState = {
    events: [],
    flushTimer: null,
    destroyed: false,
  };

  // SIGTERM / SIGINT 时同步 flush 一次最后批次。Node 退出钩子非异步；
  // 直接 fire-and-forget fetch，进程退出前能发出去就发，发不出就丢。
  const shutdownHook = () => {
    if (state.events.length > 0) {
      void flushNow().catch(() => {
        /* 进程要退了，吞 */
      });
    }
  };
  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('SIGTERM', shutdownHook);
    process.on('SIGINT', shutdownHook);
    process.on('beforeExit', shutdownHook);
  }

  function scheduleFlush(): void {
    if (state.flushTimer || state.destroyed) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void flushNow().catch(err => {
        logger.warn('[ExposureQueue] flush 异常（已吞）:', err);
      });
    }, flushIntervalMs);
    // 不阻塞 Node 进程退出
    state.flushTimer.unref?.();
  }

  async function flushNow(): Promise<void> {
    if (state.events.length === 0) return;
    const batch = state.events.splice(0, batchSize);

    try {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        // engine 跟 admin-server 同一内网；3s 硬超时
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        logger.warn(
          `[ExposureQueue] admin-server 返回 ${res.status}，丢弃 ${batch.length} 条曝光（不重试，业务无影响）`
        );
      }
    } catch (err) {
      // 网络挂 / 超时 / admin-server 全宕：丢弃 + warn，不影响业务
      logger.warn(
        `[ExposureQueue] 上报失败，丢弃 ${batch.length} 条曝光（${err instanceof Error ? err.message : String(err)}）`
      );
    }

    // 还有积压就继续排
    if (state.events.length > 0) scheduleFlush();
  }

  return {
    /**
     * 入队一个曝光事件。完全同步、永远不抛错。
     * - 队列满（maxQueueSize）→ 丢最早事件（FIFO）+ critical log
     * - 采样未命中 → 直接丢弃
     */
    push(event: ExposureEvent): void {
      if (state.destroyed) return;

      // 采样
      if (sampleRate < 1 && Math.random() >= sampleRate) return;

      // 防爆
      if (state.events.length >= maxQueueSize) {
        const dropped = state.events.shift();
        logger.warn(`[ExposureQueue] 队列满（${maxQueueSize}）丢弃最早事件，admin-server 可能下线`);
        if (!dropped) return;
      }

      state.events.push(event);

      // 攒够一批 → 立即 flush
      if (state.events.length >= batchSize) {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        void flushNow().catch(err => {
          logger.warn('[ExposureQueue] flush 异常（已吞）:', err);
        });
      } else {
        scheduleFlush();
      }
    },

    /** 立即 flush 当前批次（测试 / 优雅退出用） */
    async flush(): Promise<void> {
      await flushNow();
    },

    /** 销毁队列（清定时器、丢残留）；engine 关闭时调 */
    destroy(): void {
      state.destroyed = true;
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      state.events.length = 0;
    },

    /** 测试用：当前队列长度 */
    get size(): number {
      return state.events.length;
    },
  };
}

export type ExposureQueueInstance = ReturnType<typeof createExposureQueue>;

/**
 * 解析配置，决定是否创建 queue 实例。配置缺失 / disabled / 无 endpoint 返回 null。
 * services.api 或 services.telemetry origin 用于把相对路径补全为绝对 URL。
 */
export function resolveExposureQueue(
  config: RuntimeExperimentTrackingConfig | undefined,
  baseOrigin: string | undefined
): ExposureQueueInstance | null {
  if (!config?.endpoint) return null;
  if (config.enabled === false) return null;

  // 相对路径 → 拼到 baseOrigin；绝对路径直接用
  let endpoint = config.endpoint;
  if (endpoint.startsWith('/')) {
    if (!baseOrigin) {
      logger.warn('[ExposureQueue] endpoint 是相对路径但没有 baseOrigin，跳过 exposure 上报');
      return null;
    }
    endpoint = baseOrigin.replace(/\/$/, '') + endpoint;
  }

  return createExposureQueue({
    endpoint,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    sampleRate: config.sampleRate,
  });
}
