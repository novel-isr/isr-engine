import { RenderModeType, InternalStrategyType } from './ISRConfig';

/**
 * 统一渲染元数据接口
 * 用于在引擎内部流转以及传递给客户端
 */
export interface RenderMetadata {
  renderModeType: RenderModeType;
  /** 兼容历史字段：部分调用链会注入 renderMode */
  renderMode?: RenderModeType;
  timestamp: number;
  renderTime: number;
  fromCache: boolean;
}

/**
 * 渲染诊断数据
 * 用于调试、监控和性能分析，与核心 RenderMetadata 分离
 *
 * 字段分为两类：
 * - 基础诊断字段：每次渲染都会产生
 * - ISR/降级链字段：仅在特定场景下存在
 */
export interface RenderDiagnostics {
  // ========== 基础诊断字段 ==========
  /** 渲染的组件数量 */
  componentCount: number;
  /** 实际执行的内部策略 */
  strategy: InternalStrategyType;
  /** 是否使用了降级策略 */
  fallbackUsed: boolean;
  /** 缓存命中 */
  cacheHit: boolean;

  // ========== ISR 缓存相关（仅 ISR 模式） ==========
  /** ISR 缓存生成时间戳 (ms) */
  generated?: number;
  /** ISR 上次重新生成时间戳 (ms) */
  lastRegenerated?: number;
  /** ISR 下次需要重新验证的时间戳 (ms) */
  revalidateAfter?: number;
  /** 是否需要重新验证 */
  needsRevalidation?: boolean;
  /** 缓存年龄 (ms) */
  cacheAge?: number;

  // ========== 降级链相关（仅降级链执行时） ==========
  /** 降级链总响应时间 (ms) */
  totalResponseTime?: number;
  /** 降级链尝试过的策略列表 */
  attemptedStrategies?: InternalStrategyType[];
}
