import type { ISRConfig, RenderModeType, RouteRule } from '@/types';
import ISREngine from '@/engine/ISREngine';

/**
 * 配置归一化：消费端使用 `mode` / `routes` 别名时映射为标准字段
 */
function normalizeAppConfig(raw: ISRConfig): ISRConfig {
  const config = { ...raw };

  if (config.mode && !config.renderMode) {
    config.renderMode = config.mode as RenderModeType;
  }
  if ((config as { routes?: Record<string, RouteRule> }).routes && !config.routeOverrides) {
    config.routeOverrides = (config as { routes: Record<string, RouteRule> }).routes;
  }

  return config;
}

/**
 * 配置验证（无效配置立即抛错，禁止静默降级）
 */
function validateConfig(config: ISRConfig): void {
  const validModes: RenderModeType[] = ['isr', 'ssr', 'ssg'];

  if (config.renderMode && !validModes.includes(config.renderMode)) {
    throw new Error(`无效的 renderMode: "${config.renderMode}"，可选值: ${validModes.join(', ')}`);
  }

  if (!config.cache) {
    config.cache = { strategy: 'memory', ttl: 3600 };
  }
  if (!config.seo) {
    config.seo = { enabled: true, generateSitemap: true, generateRobots: true };
  }
  if (!config.renderMode) {
    config.renderMode = 'isr';
  }
}

/**
 * 创建 ISR 应用 —— 开箱即用的引擎封装
 *
 * 返回值：
 *   - engine    —— ISREngine 实例，可调用 invalidate / generateSeo 等
 *   - start()   —— 启动 Express + Vite 服务器
 *   - shutdown()—— 优雅关闭
 *
 * 页面渲染由 `@vitejs/plugin-rsc` 的 fetch handler 完成，不在本 API 暴露。
 */
export async function createISRApp(appOption: ISRConfig) {
  const normalizedConfig = normalizeAppConfig(appOption);
  validateConfig(normalizedConfig);

  const engine = new ISREngine(normalizedConfig);

  return {
    engine,
    appOption: normalizedConfig,
    start: async () => engine.start(),
    shutdown: async () => engine.shutdown(),
  };
}
