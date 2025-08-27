/**
 * 企业级错误处理系统
 * 提供完整的错误分类、重试、降级、监控功能
 */

export enum ErrorType {
  NETWORK = 'NETWORK',
  RENDER = 'RENDER',
  CACHE = 'CACHE',
  CONFIG = 'CONFIG',
  TIMEOUT = 'TIMEOUT',
  VALIDATION = 'VALIDATION',
  UNKNOWN = 'UNKNOWN',
}

export enum ErrorSeverity {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  CRITICAL = 4,
}

export interface ErrorContext {
  url?: string;
  method?: string;
  userAgent?: string;
  renderMode?: string;
  strategy?: string;
  timestamp: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
}

export interface ISRError extends Error {
  type: ErrorType;
  severity: ErrorSeverity;
  code: string;
  context: ErrorContext;
  retryable: boolean;
  fallbackStrategy?: string;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors: ErrorType[];
}

export interface FallbackStrategy {
  name: string;
  condition: (error: ISRError) => boolean;
  handler: (error: ISRError, context: any) => Promise<any>;
  priority: number;
}

export class ErrorHandler {
  private retryConfig: RetryConfig;
  private fallbackStrategies: FallbackStrategy[] = [];
  private errorMetrics: Map<string, { count: number; lastOccurred: Date }> = new Map();

  constructor(retryConfig?: Partial<RetryConfig>) {
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      retryableErrors: [ErrorType.NETWORK, ErrorType.TIMEOUT, ErrorType.CACHE],
      ...retryConfig,
    };

    this.setupDefaultFallbackStrategies();
  }

  /**
   * 创建标准化的ISR错误
   */
  createError(
    message: string,
    type: ErrorType,
    severity: ErrorSeverity,
    code: string,
    context: Partial<ErrorContext>,
    retryable: boolean = true
  ): ISRError {
    const error = new Error(message) as ISRError;
    error.type = type;
    error.severity = severity;
    error.code = code;
    error.context = {
      timestamp: new Date().toISOString(),
      ...context,
    };
    error.retryable = retryable;

    return error;
  }

  /**
   * 处理错误，包括重试、降级、监控
   */
  async handle<T>(
    operation: () => Promise<T>,
    context: Partial<ErrorContext> = {},
    customRetryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.retryConfig, ...customRetryConfig };
    let lastError: ISRError;
    
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // 如果成功且之前有错误，记录恢复
        if (attempt > 0) {
          console.log(`🔄 操作成功恢复，尝试次数: ${attempt + 1}`);
        }
        
        return result;
      } catch (error) {
        lastError = this.normalizeError(error, context);
        
        // 记录错误指标
        this.recordErrorMetrics(lastError);
        
        // 检查是否可以重试
        if (attempt < config.maxRetries && this.isRetryable(lastError, config)) {
          const delay = Math.min(
            config.baseDelay * Math.pow(config.backoffMultiplier, attempt),
            config.maxDelay
          );
          
          console.warn(`⚠️ 操作失败，${delay}ms后重试 (${attempt + 1}/${config.maxRetries}):`, {
            error: lastError.message,
            type: lastError.type,
            code: lastError.code,
          });
          
          await this.sleep(delay);
          continue;
        }
        
        break;
      }
    }

    // 所有重试都失败，尝试降级策略
    console.error(`❌ 操作最终失败，尝试降级策略:`, lastError);
    return this.executeFallbackStrategy(lastError, context);
  }

  /**
   * 注册自定义降级策略
   */
  registerFallbackStrategy(strategy: FallbackStrategy): void {
    this.fallbackStrategies.push(strategy);
    this.fallbackStrategies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取错误统计信息
   */
  getErrorMetrics(): { [key: string]: { count: number; lastOccurred: Date } } {
    return Object.fromEntries(this.errorMetrics);
  }

  /**
   * 清理错误统计（定期清理）
   */
  cleanupMetrics(olderThanHours: number = 24): void {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    
    for (const [key, metrics] of this.errorMetrics) {
      if (metrics.lastOccurred < cutoff) {
        this.errorMetrics.delete(key);
      }
    }
  }

  private setupDefaultFallbackStrategies(): void {
    // ISR 降级到 SSR
    this.registerFallbackStrategy({
      name: 'isr-to-ssr',
      condition: (error) => error.context.renderMode === 'isr' && error.type === ErrorType.CACHE,
      handler: async (error, context) => {
        console.warn('🔄 ISR缓存失败，降级到SSR');
        return { 
          fallbackStrategy: 'ssr',
          renderMode: 'ssr',
          reason: 'ISR cache failure',
        };
      },
      priority: 100,
    });

    // SSR 降级到 CSR
    this.registerFallbackStrategy({
      name: 'ssr-to-csr',
      condition: (error) => error.context.renderMode === 'ssr' && error.type === ErrorType.RENDER,
      handler: async (error, context) => {
        console.warn('🔄 SSR渲染失败，降级到CSR');
        return {
          fallbackStrategy: 'csr',
          renderMode: 'csr',
          reason: 'SSR render failure',
        };
      },
      priority: 90,
    });

    // 网络错误降级
    this.registerFallbackStrategy({
      name: 'network-fallback',
      condition: (error) => error.type === ErrorType.NETWORK,
      handler: async (error, context) => {
        console.warn('🔄 网络错误，使用缓存内容');
        return {
          fallbackStrategy: 'cached',
          renderMode: 'cached',
          reason: 'Network failure',
        };
      },
      priority: 80,
    });

    // 通用CSR降级（最后手段）
    this.registerFallbackStrategy({
      name: 'universal-csr-fallback',
      condition: () => true,
      handler: async (error, context) => {
        console.warn('🔄 所有策略失败，最终降级到CSR');
        return {
          fallbackStrategy: 'csr',
          renderMode: 'csr',
          reason: 'Universal fallback',
          html: this.generateCSRFallbackHTML(context),
        };
      },
      priority: 1,
    });
  }

  private normalizeError(error: any, context: Partial<ErrorContext>): ISRError {
    if (error.type && error.severity) {
      return error as ISRError;
    }

    let type = ErrorType.UNKNOWN;
    let severity = ErrorSeverity.MEDIUM;
    let code = 'UNKNOWN_ERROR';

    // 根据错误信息推断类型
    const message = error.message || String(error);
    if (message.includes('timeout') || message.includes('TIMEOUT')) {
      type = ErrorType.TIMEOUT;
      code = 'OPERATION_TIMEOUT';
    } else if (message.includes('network') || message.includes('fetch')) {
      type = ErrorType.NETWORK;
      code = 'NETWORK_ERROR';
    } else if (message.includes('render') || message.includes('React')) {
      type = ErrorType.RENDER;
      code = 'RENDER_ERROR';
      severity = ErrorSeverity.HIGH;
    } else if (message.includes('cache')) {
      type = ErrorType.CACHE;
      code = 'CACHE_ERROR';
    }

    return this.createError(message, type, severity, code, context);
  }

  private isRetryable(error: ISRError, config: RetryConfig): boolean {
    return error.retryable && config.retryableErrors.includes(error.type);
  }

  private async executeFallbackStrategy(error: ISRError, context: any): Promise<any> {
    for (const strategy of this.fallbackStrategies) {
      if (strategy.condition(error)) {
        try {
          console.log(`🔄 执行降级策略: ${strategy.name}`);
          const result = await strategy.handler(error, context);
          return result;
        } catch (strategyError) {
          console.error(`❌ 降级策略 ${strategy.name} 失败:`, strategyError);
          continue;
        }
      }
    }

    // 如果所有降级策略都失败，抛出原始错误
    throw error;
  }

  private recordErrorMetrics(error: ISRError): void {
    const key = `${error.type}-${error.code}`;
    const existing = this.errorMetrics.get(key);
    
    this.errorMetrics.set(key, {
      count: (existing?.count || 0) + 1,
      lastOccurred: new Date(),
    });
  }

  private generateCSRFallbackHTML(context: any): string {
    return `
      <div id="csr-fallback-message" style="
        display: flex; 
        flex-direction: column; 
        align-items: center; 
        justify-content: center; 
        height: 50vh; 
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      ">
        <div style="margin-bottom: 1rem;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚡</div>
          <h2 style="margin: 0; color: #333;">正在加载应用...</h2>
          <p style="color: #666; margin: 0.5rem 0;">请稍等，页面正在客户端渲染</p>
        </div>
        <div style="
          width: 40px; 
          height: 40px; 
          border: 3px solid #f3f3f3; 
          border-top: 3px solid #3498db; 
          border-radius: 50%; 
          animation: spin 1s linear infinite;
        "></div>
        <style>
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </div>
    `;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 全局错误处理器实例
export const globalErrorHandler = new ErrorHandler();

// 错误工厂函数
export const createNetworkError = (message: string, context: Partial<ErrorContext> = {}) =>
  globalErrorHandler.createError(message, ErrorType.NETWORK, ErrorSeverity.MEDIUM, 'NETWORK_ERROR', context);

export const createRenderError = (message: string, context: Partial<ErrorContext> = {}) =>
  globalErrorHandler.createError(message, ErrorType.RENDER, ErrorSeverity.HIGH, 'RENDER_ERROR', context);

export const createCacheError = (message: string, context: Partial<ErrorContext> = {}) =>
  globalErrorHandler.createError(message, ErrorType.CACHE, ErrorSeverity.MEDIUM, 'CACHE_ERROR', context);

export const createTimeoutError = (message: string, context: Partial<ErrorContext> = {}) =>
  globalErrorHandler.createError(message, ErrorType.TIMEOUT, ErrorSeverity.MEDIUM, 'TIMEOUT_ERROR', context);