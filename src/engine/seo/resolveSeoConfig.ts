/**
 * SEO 配置解析器 —— 唯一的 baseUrl 解析入口
 *
 * 设计目标：
 *   - SEO 是 SSR/ISR 基础能力，始终启用，不暴露 enabled/sitemap/robots 开关
 *   - 用户在 ssr.config.ts 里只关心 prod 域名是什么
 *   - env-var 兜底链 / dev 默认 / prod 报错 —— 全部由 engine 收口，不再泄漏到用户配置
 */
import { Logger } from '../../logger/Logger';
import { isDev } from '../../config/getStatus';
import type { ISRConfig } from '../../types';

const logger = Logger.getInstance();

export interface ResolvedSeoConfig {
  /** 真实可用的 baseUrl（已解析所有 fallback）；prod 未配置时为空串 */
  baseUrl: string;
  /** 解析来源（便于 admin / 日志） */
  baseUrlSource:
    | 'runtime.site'
    | 'env:SEO_BASE_URL'
    | 'env:PUBLIC_BASE_URL'
    | 'env:BASE_URL'
    | 'dev-default'
    | 'unset';
}

/**
 * 按以下顺序解析 baseUrl：
 *   1. runtime.site
 *   2. env `SEO_BASE_URL` → `PUBLIC_BASE_URL` → `BASE_URL`
 *   3. dev 模式：`http://localhost:${server.port||3000}`
 *   4. prod 且未配置：返回空串（SEOEngine 在调用 generateSitemap 时报错给出修复提示）
 */
export function resolveSeoConfig(config: ISRConfig): ResolvedSeoConfig {
  let baseUrl = '';
  let source: ResolvedSeoConfig['baseUrlSource'] = 'unset';

  if (config.runtime?.site) {
    baseUrl = config.runtime.site;
    source = 'runtime.site';
  } else if (process.env.SEO_BASE_URL) {
    baseUrl = process.env.SEO_BASE_URL;
    source = 'env:SEO_BASE_URL';
  } else if (process.env.PUBLIC_BASE_URL) {
    baseUrl = process.env.PUBLIC_BASE_URL;
    source = 'env:PUBLIC_BASE_URL';
  } else if (process.env.BASE_URL) {
    baseUrl = process.env.BASE_URL;
    source = 'env:BASE_URL';
  } else if (isDev()) {
    const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
    const port = config.server?.port ?? (Number.isFinite(envPort) ? envPort : 3000);
    baseUrl = `http://localhost:${port}`;
    source = 'dev-default';
  }

  if (!baseUrl) {
    logger.warn(
      '⚠️  SEO baseUrl 未配置：sitemap 端点将报错。请在 ssr.config.ts 设置 runtime.site 或注入 SEO_BASE_URL / PUBLIC_BASE_URL / BASE_URL 环境变量。'
    );
  } else {
    logger.info(`🎯 SEO baseUrl=${baseUrl}（来源：${source}）`);
  }

  return { baseUrl, baseUrlSource: source };
}
