import { RenderModes, InternalStrategies, FallbackChain } from '../types';

/**
 * Enterprise Render Mode Manager
 * Handles automatic fallback chains with simplified public API
 */
export class RenderMode {
  private mode: string;
  private config: Record<string, any>;
  private fallbackChain: string[];

  constructor(mode: string, config: Record<string, any>) {
    // Validate mode - only allow SSG or ISR
    if (!Object.values(RenderModes).includes(mode as any)) {
      throw new Error(
        `Invalid render mode: ${mode}. Only 'ssg' and 'isr' are supported.`
      );
    }

    this.mode = mode;
    this.config = config;
    this.fallbackChain = FallbackChain[mode] || FallbackChain.isr;
  }

  isSSG() {
    return this.mode === RenderModes.SSG;
  }

  isISR() {
    return this.mode === RenderModes.ISR;
  }

  /**
   * Get the complete fallback chain for current mode
   * Enterprise-level automatic fallback handling
   */
  getFallbackChain(route: string) {
    if (this.isSSG()) {
      return ['static', 'client'];
    }

    // ISR mode - full fallback chain
    return ['cached', 'regenerate', 'server', 'client'];
  }

  /**
   * Get the primary strategy for a route
   * This determines the first attempt strategy
   */
  getPrimaryStrategy(route: string) {
    if (this.isSSG()) {
      return InternalStrategies.STATIC;
    }

    if (this.isISR()) {
      // Check if we should try cache first or regenerate
      return this.shouldTryCache(route)
        ? InternalStrategies.CACHED
        : InternalStrategies.REGENERATE;
    }

    // Default to ISR cached strategy
    return InternalStrategies.CACHED;
  }

  /**
   * Determine if we should try cached version first
   * Internal logic for ISR optimization
   */
  shouldTryCache(route: string) {
    // Always try cache first - let ISR module handle revalidation
    return true;
  }

  /**
   * Check if route should be prerendered (SSG only)
   */
  shouldPrerender(route: string) {
    return this.isSSG();
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use getPrimaryStrategy instead
   */
  getRenderStrategy(route: string) {
    const strategy = this.getPrimaryStrategy(route);

    // Map internal strategies to legacy names
    const strategyMap = {
      [InternalStrategies.STATIC]: 'static',
      [InternalStrategies.CACHED]: 'cached',
      [InternalStrategies.REGENERATE]: 'regenerate',
      [InternalStrategies.SERVER]: 'server',
      [InternalStrategies.CLIENT]: 'client',
    };

    return strategyMap[strategy] || 'cached';
  }

  /**
   * Get configuration for the current mode
   */
  getConfig() {
    return {
      mode: this.mode,
      fallbackChain: this.fallbackChain,
      supportsRevalidation: this.isISR(),
      isStatic: this.isSSG(),
    };
  }
}
