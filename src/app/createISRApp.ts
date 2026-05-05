import type { ISRConfig, RenderModeType } from '@/types';
import ISREngine from '@/engine/ISREngine';
import { normalizeEngineConfig } from '@/config/normalizeEngineConfig';

function normalizeAppConfig(raw: ISRConfig): ISRConfig {
  return normalizeEngineConfig(raw);
}

/**
 * 配置验证（无效配置立即抛错，禁止静默降级）
 */
function validateConfig(config: ISRConfig): void {
  const validModes: RenderModeType[] = ['isr', 'ssr', 'ssg'];

  if (config.renderMode && !validModes.includes(config.renderMode)) {
    throw new Error(`无效的 renderMode: "${config.renderMode}"，可选值: ${validModes.join(', ')}`);
  }

  // SEO is a core SSR/ISR capability and is always enabled by the engine.
  // Sitemap/robots endpoints are registered by the server layer; business apps
  // only provide runtime.site and runtime.seo data sources.
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
