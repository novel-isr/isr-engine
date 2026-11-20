/**
 * SEO 配置解析器 —— 唯一的 baseUrl 解析入口
 *
 * 设计目标：
 *   - SEO 是 SSR/ISR 基础能力，始终启用，不暴露 enabled/sitemap/robots 开关
 *   - 用户在 ssr.config.ts 里只关心 prod 域名是什么
 *   - prod 只读 runtime.site，避免 SEO baseUrl 变成隐藏环境变量
 *   - dev 自动用 localhost，降低本地启动成本
 */
import { Logger } from '../../logger/Logger';
import { isDev } from '../../config/getStatus';
import type { ISRConfig } from '../../types';
import { SEOEngine } from './SEOEngine';

const logger = Logger.getInstance();

export interface ResolvedSeoConfig {
  /** 真实可用的 baseUrl（已解析所有 fallback）；prod 未配置时为空串 */
  baseUrl: string;
  /** 解析来源（便于 admin / 日志） */
  baseUrlSource: 'runtime.site' | 'dev-default' | 'unset';
}

/**
 * 按以下顺序解析 baseUrl：
 *   1. runtime.site
 *   2. dev 模式：`http://localhost:${server.port||3000}`
 *   3. prod 且未配置：返回空串（SEOEngine 在调用 generateSitemap 时报错给出修复提示）
 */
export function resolveSeoConfig(config: ISRConfig): ResolvedSeoConfig {
  let baseUrl = '';
  let source: ResolvedSeoConfig['baseUrlSource'] = 'unset';

  if (config.runtime?.site) {
    baseUrl = config.runtime.site;
    source = 'runtime.site';
  } else if (isDev()) {
    const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
    const port = config.server?.port ?? (Number.isFinite(envPort) ? envPort : 3000);
    baseUrl = `http://localhost:${port}`;
    source = 'dev-default';
  }

  if (!baseUrl) {
    logger.warn(
      '⚠️  SEO baseUrl 未配置：sitemap 端点将报错。请在 ssr.config.ts 设置 runtime.site。'
    );
  } else {
    logger.info(`🎯 SEO baseUrl=${baseUrl}（来源：${source}）`);
  }

  return { baseUrl, baseUrlSource: source };
}

/** 取本地 SEO 条目明确声明的内容更新时间，仅用于完全匹配的 sitemap URL。 */
export function resolveSitemapLastModified(config: ISRConfig): ReadonlyMap<string, string> {
  const timestamps = new Map<string, string>();
  for (const { path, modifiedTime } of config.runtime?.seo?.fallbackLocal ?? []) {
    if (typeof path === 'string' && typeof modifiedTime === 'string' && !timestamps.has(path)) {
      timestamps.set(path, modifiedTime);
    }
  }
  return timestamps;
}

export function resolveSitemapLoader(config: ISRConfig, engine?: SEOEngine) {
  const seo = config.runtime?.seo;
  const source = seo?.sitemap;
  if (!source) return;
  const sitemap = engine ?? SEOEngine.getInstance({ baseUrl: resolveSeoConfig(config).baseUrl });
  return {
    ttl: source.ttl ?? seo.ttl,
    load: async () =>
      sitemap.generatePublishedSitemap(await source.load({ services: config.runtime.services })),
  };
}
