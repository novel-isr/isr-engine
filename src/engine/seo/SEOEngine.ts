/**
 * SEO 引擎 - 单例模式
 *
 * 核心功能：
 * - Meta 标签生成
 * - 结构化数据(JSON-LD)生成
 * - 站点地图生成
 * - Open Graph / Twitter Cards
 */

import { SitemapStream, streamToPromise } from 'sitemap';
import { Logger } from '../../logger/Logger';
import type { SEOConfig, SEOPageData, DeepPartial } from './types';
import { DEFAULT_SEO_CONFIG, mergeSEOConfig } from './config';

export class SEOEngine {
  private static instance: SEOEngine | null = null;
  private readonly logger = Logger.getInstance();
  private config: SEOConfig;
  private initialized = false;

  // 缓存
  private pageDataCache = new Map<string, SEOPageData>();
  private sitemapCache: string | null = null;
  private sitemapLastGenerated = 0;

  private constructor(config?: DeepPartial<SEOConfig>) {
    this.config = config ? mergeSEOConfig(DEFAULT_SEO_CONFIG, config) : { ...DEFAULT_SEO_CONFIG };
  }

  /** 获取单例实例 */
  static getInstance(config?: DeepPartial<SEOConfig>): SEOEngine {
    if (!SEOEngine.instance) {
      SEOEngine.instance = new SEOEngine(config);
    }
    return SEOEngine.instance;
  }

  /** 重置实例（仅用于测试） */
  static resetInstance(): void {
    SEOEngine.instance = null;
  }

  /** 更新配置 */
  updateConfig(config: DeepPartial<SEOConfig>): void {
    this.config = mergeSEOConfig(this.config, config);
    this.clearCache();
  }

  /** 获取当前配置 */
  getConfig(): SEOConfig {
    return this.config;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger.info('🎯 初始化 SEO 引擎...');
    this.initialized = true;
    this.logger.info('✅ SEO 引擎初始化完成');
  }

  /** 优化页面 SEO */
  async optimizePage<T extends { html: string; meta?: unknown }>(
    url: string,
    context: unknown,
    result: T
  ): Promise<T & { seoScore: number }> {
    if (!this.config.enabled) {
      return { ...result, seoScore: 0 };
    }

    const pageData = this.getOrCreatePageData(url, context);
    const seoTags = this.generateAllTags(pageData);
    const structuredData = this.generateStructuredData(pageData);
    const html = this.insertSEOTags(result.html, seoTags, structuredData);

    return {
      ...result,
      html,
      seoScore: this.calculateScore(pageData),
      meta: { ...(result.meta as object), seoOptimized: true },
    };
  }

  /** 生成站点地图 */
  async generateSitemap(routes?: string[]): Promise<string> {
    const now = Date.now();
    if (
      this.sitemapCache &&
      now - this.sitemapLastGenerated < this.config.sitemap.cacheTimeout * 1000
    ) {
      return this.sitemapCache;
    }

    // SEO 必须显式配置 baseUrl，禁止静默降级到占位域名
    if (!this.config.baseUrl) {
      throw new Error(
        'SEO baseUrl 未配置，无法生成 sitemap。请设置 ssr.config.seo.baseUrl 或 SEO_BASE_URL / PUBLIC_BASE_URL 环境变量。'
      );
    }
    const sitemap = new SitemapStream({ hostname: this.config.baseUrl });
    const urls = routes || Array.from(this.pageDataCache.keys());
    // 兜底：未传入路由 + 无 pageData 缓存时，至少把首页写入，避免 EmptySitemap 报错
    const finalUrls = urls.length > 0 ? urls : ['/'];

    for (const url of finalUrls) {
      if (this.shouldExcludeUrl(url)) continue;

      sitemap.write({
        url,
        priority: this.getUrlPriority(url),
        changefreq: this.getUrlChangeFreq(url),
        lastmod: new Date().toISOString(),
      });
    }

    sitemap.end();
    this.sitemapCache = (await streamToPromise(sitemap)).toString();
    this.sitemapLastGenerated = now;

    this.logger.info(`✅ 站点地图已生成: ${urls.length} 个页面`);
    return this.sitemapCache;
  }

  /** 生成 Robots.txt */
  generateRobotsTxt(): string {
    return [
      'User-agent: *',
      'Allow: /',
      '',
      ...this.config.sitemap.excludePatterns.map(p => `Disallow: ${p}`),
      '',
      `Sitemap: ${this.config.baseUrl}/sitemap.xml`,
    ].join('\n');
  }

  /** 清理缓存 */
  clearCache(): void {
    this.pageDataCache.clear();
    this.sitemapCache = null;
    this.sitemapLastGenerated = 0;
  }

  /** 关闭引擎 */
  async shutdown(): Promise<void> {
    this.clearCache();
    this.initialized = false;
    this.logger.debug('✅ SEO 引擎已关闭');
  }

  // ========== 私有方法 ==========

  private getOrCreatePageData(url: string, context: unknown): SEOPageData {
    const cached = this.pageDataCache.get(url);
    if (cached) return cached;

    const pageType = this.detectPageType(url);
    const pageData: SEOPageData = {
      url: `${this.config.baseUrl}${url}`,
      title: this.generateTitle(url),
      description: this.generateDescription(url, pageType),
      keywords: [...this.config.keywords, ...this.extractKeywordsFromUrl(url)],
      image: this.config.openGraph.defaultImage,
      type: pageType,
      language: this.detectLanguage(url, context),
      modifiedTime: new Date().toISOString(),
    };

    this.pageDataCache.set(url, pageData);
    return pageData;
  }

  private generateAllTags(pageData: SEOPageData): string {
    const tags: string[] = [];

    // Meta 标签
    tags.push(`<title>${pageData.title}</title>`);
    tags.push(`<meta name="description" content="${pageData.description}">`);
    if (pageData.keywords?.length) {
      tags.push(`<meta name="keywords" content="${pageData.keywords.join(', ')}">`);
    }
    tags.push(`<meta name="author" content="${this.config.author}">`);
    tags.push(`<meta name="robots" content="${this.config.robots}">`);
    tags.push(`<link rel="canonical" href="${pageData.url}">`);

    // Open Graph
    if (this.config.openGraph.enabled) {
      tags.push(`<meta property="og:title" content="${pageData.title}">`);
      tags.push(`<meta property="og:description" content="${pageData.description}">`);
      tags.push(`<meta property="og:type" content="${pageData.type}">`);
      tags.push(`<meta property="og:url" content="${pageData.url}">`);
      tags.push(`<meta property="og:site_name" content="${this.config.siteName}">`);
      tags.push(`<meta property="og:locale" content="${this.config.openGraph.locale}">`);
      if (pageData.image) {
        tags.push(`<meta property="og:image" content="${pageData.image}">`);
      }
    }

    // Twitter Cards
    if (this.config.twitter.enabled) {
      tags.push(`<meta name="twitter:card" content="${this.config.twitter.card}">`);
      tags.push(`<meta name="twitter:site" content="${this.config.twitter.site}">`);
      tags.push(`<meta name="twitter:title" content="${pageData.title}">`);
      tags.push(`<meta name="twitter:description" content="${pageData.description}">`);
      if (pageData.image) {
        tags.push(`<meta name="twitter:image" content="${pageData.image}">`);
      }
    }

    return tags.join('\n    ');
  }

  private generateStructuredData(pageData: SEOPageData): string {
    if (!this.config.structuredData.enabled) return '';

    const data: unknown[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: this.config.siteName,
        url: this.config.baseUrl,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: this.config.siteName,
        url: this.config.baseUrl,
        logo: this.config.structuredData.organizationLogo,
      },
    ];

    if (pageData.type === 'article') {
      data.push({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: pageData.title,
        description: pageData.description,
        url: pageData.url,
        dateModified: pageData.modifiedTime,
        author: { '@type': 'Person', name: pageData.author || this.config.author },
      });
    }

    return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
  }

  private insertSEOTags(html: string, seoTags: string, structuredData: string): string {
    const headEndIndex = html.indexOf('</head>');
    if (headEndIndex === -1) return html;

    return (
      html.slice(0, headEndIndex) +
      '    ' +
      seoTags +
      '\n' +
      '    ' +
      structuredData +
      '\n' +
      html.slice(headEndIndex)
    );
  }

  private calculateScore(pageData: SEOPageData): number {
    let score = 0;
    if (pageData.title && pageData.title.length >= 30 && pageData.title.length <= 60) score += 25;
    else if (pageData.title) score += 15;
    if (pageData.description && pageData.description.length >= 100) score += 25;
    else if (pageData.description) score += 15;
    if (pageData.keywords && pageData.keywords.length >= 3) score += 20;
    if (pageData.image) score += 15;
    if (this.config.structuredData.enabled) score += 15;
    return Math.min(score, 100);
  }

  private detectPageType(url: string): 'website' | 'article' | 'product' {
    if (url.includes('/blog/') || url.includes('/article/')) return 'article';
    if (url.includes('/product/') || url.includes('/shop/')) return 'product';
    return 'website';
  }

  private generateTitle(url: string): string {
    if (url === '/') return this.config.defaultTitle;
    const segments = url.split('/').filter(Boolean);
    const title = segments
      .map(s => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
      .join(' - ');
    return this.config.titleTemplate.replace('%s', title);
  }

  private generateDescription(url: string, pageType: string): string {
    if (url === '/') return this.config.defaultDescription;
    const topic = url.split('/').pop()?.replace(/-/g, ' ') || '';
    if (pageType === 'article') return `阅读关于 ${topic} 的最新文章。`;
    if (pageType === 'product') return `探索 ${topic} 的详细信息。`;
    return `了解更多关于 ${topic} 的内容。`;
  }

  private extractKeywordsFromUrl(url: string): string[] {
    return url
      .split('/')
      .filter(Boolean)
      .flatMap(s => s.split('-'));
  }

  private detectLanguage(url: string, _context: unknown): string {
    const pathLang = url.split('/')[1];
    if (this.config.supportedLanguages.includes(pathLang)) return pathLang;
    return this.config.defaultLanguage;
  }

  private shouldExcludeUrl(url: string): boolean {
    return this.config.sitemap.excludePatterns.some(pattern =>
      new RegExp(pattern.replace(/\*/g, '.*')).test(url)
    );
  }

  private getUrlPriority(url: string): number {
    for (const [pattern, priority] of Object.entries(this.config.sitemap.priority)) {
      if (pattern === '*' || new RegExp(pattern.replace(/\*/g, '.*')).test(url)) {
        return priority;
      }
    }
    return 0.5;
  }

  private getUrlChangeFreq(url: string): string {
    for (const [pattern, freq] of Object.entries(this.config.sitemap.changeFreq)) {
      if (pattern === '*' || new RegExp(pattern.replace(/\*/g, '.*')).test(url)) {
        return freq;
      }
    }
    return 'monthly';
  }
}

/** 创建 SEO 引擎实例（获取单例） */
export function createSEOEngine(config?: DeepPartial<SEOConfig>): SEOEngine {
  return SEOEngine.getInstance(config);
}
