/**
 * 企业级 SEO 优化引擎
 * 
 * 核心功能：
 * - 智能 Meta 标签生成和优化
 * - 结构化数据(JSON-LD)自动生成
 * - 站点地图动态生成和管理
 * - Open Graph 和 Twitter Cards 优化
 * - 多语言 SEO 支持
 * - 核心 Web 指标优化
 * - SEO 性能监控和分析
 */

import fs from 'fs/promises';
import path from 'path';
import { SitemapStream, streamToPromise } from 'sitemap';
import { Logger } from '../utils/Logger';
import type { RenderContext, RenderResult } from '../types';

export interface EnterpriseSEOConfig {
  // 基础配置
  enabled: boolean;
  baseUrl: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  
  // 站点地图配置
  sitemap: {
    enabled: boolean;
    priority: Record<string, number>;
    changeFreq: Record<string, string>;
    excludePatterns: string[];
    includeImages: boolean;
    includeVideos: boolean;
    autoGenerate: boolean;
    cacheTimeout: number; // 秒
  };
  
  // Meta 标签配置
  meta: {
    defaultTitle: string;
    defaultDescription: string;
    titleTemplate: string; // %s = page title
    keywords: string[];
    author: string;
    robots: string;
    canonical: boolean;
  };
  
  // Open Graph 配置
  openGraph: {
    enabled: boolean;
    type: string;
    siteName: string;
    locale: string;
    defaultImage: string;
    imageSize: { width: number; height: number };
  };
  
  // Twitter Cards 配置
  twitter: {
    enabled: boolean;
    card: string;
    site: string;
    creator: string;
  };
  
  // 结构化数据配置
  structuredData: {
    enabled: boolean;
    organization: any;
    website: any;
    breadcrumbs: boolean;
    articles: boolean;
    products: boolean;
  };
  
  // 性能优化配置
  performance: {
    enableCriticalCSS: boolean;
    enableResourceHints: boolean;
    enablePreloading: boolean;
    enableWebpImages: boolean;
  };
  
  // 监控配置
  monitoring: {
    enableAnalytics: boolean;
    enableCoreWebVitals: boolean;
    reportingEndpoint?: string;
  };
}

export interface SEOPageData {
  url: string;
  title: string;
  description: string;
  keywords?: string[];
  image?: string;
  type?: 'website' | 'article' | 'product';
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
  tags?: string[];
  language?: string;
  structuredData?: any;
}

export interface SEOMetrics {
  pagesIndexed: number;
  averagePageScore: number;
  totalIssues: number;
  criticalIssues: number;
  performanceScores: {
    averageLoadTime: number;
    coreWebVitals: {
      lcp: number; // Largest Contentful Paint
      fid: number; // First Input Delay
      cls: number; // Cumulative Layout Shift
    };
  };
  sitemapStats: {
    totalPages: number;
    lastGenerated: number;
    errors: number;
  };
}

/**
 * 企业级 SEO 优化引擎实现
 */
export class EnterpriseSEOEngine {
  private config: EnterpriseSEOConfig;
  private logger: Logger;
  private projectRoot: string;
  
  // 页面数据管理
  private pageDataCache: Map<string, SEOPageData>;
  private sitemapCache: string | null;
  private sitemapLastGenerated: number;
  
  // 结构化数据模板
  private structuredDataTemplates: Map<string, any>;
  
  // 性能监控
  private performanceMetrics: Map<string, any>;
  private coreWebVitalsData: Array<{
    url: string;
    metrics: any;
    timestamp: number;
  }>;

  constructor(projectRoot: string, config: Partial<EnterpriseSEOConfig> = {}, verbose = false) {
    this.projectRoot = projectRoot;
    this.logger = new Logger(verbose);
    
    // 默认配置
    this.config = {
      enabled: true,
      baseUrl: 'https://example.com',
      defaultLanguage: 'en',
      supportedLanguages: ['en', 'zh', 'es', 'fr'],
      sitemap: {
        enabled: true,
        priority: {
          '/': 1.0,
          '/about': 0.8,
          '/products/*': 0.9,
          '/blog/*': 0.7,
          '*': 0.5,
        },
        changeFreq: {
          '/': 'daily',
          '/blog/*': 'weekly',
          '*': 'monthly',
        },
        excludePatterns: ['/admin/*', '/api/*', '/private/*'],
        includeImages: true,
        includeVideos: false,
        autoGenerate: true,
        cacheTimeout: 3600,
      },
      meta: {
        defaultTitle: 'Enterprise Application',
        defaultDescription: 'A powerful enterprise application built with ISR technology',
        titleTemplate: '%s | Enterprise App',
        keywords: ['enterprise', 'application', 'ISR', 'React'],
        author: 'Enterprise Team',
        robots: 'index,follow',
        canonical: true,
      },
      openGraph: {
        enabled: true,
        type: 'website',
        siteName: 'Enterprise Application',
        locale: 'en_US',
        defaultImage: '/images/og-default.jpg',
        imageSize: { width: 1200, height: 630 },
      },
      twitter: {
        enabled: true,
        card: 'summary_large_image',
        site: '@enterprise_app',
        creator: '@enterprise_team',
      },
      structuredData: {
        enabled: true,
        organization: {
          '@type': 'Organization',
          name: 'Enterprise Corp',
          url: 'https://enterprise.com',
          logo: 'https://enterprise.com/logo.png',
        },
        website: {
          '@type': 'WebSite',
          name: 'Enterprise Application',
          url: 'https://enterprise.com',
        },
        breadcrumbs: true,
        articles: true,
        products: true,
      },
      performance: {
        enableCriticalCSS: true,
        enableResourceHints: true,
        enablePreloading: true,
        enableWebpImages: true,
      },
      monitoring: {
        enableAnalytics: true,
        enableCoreWebVitals: true,
      },
      ...config,
    };

    // 初始化内部状态
    this.pageDataCache = new Map();
    this.sitemapCache = null;
    this.sitemapLastGenerated = 0;
    this.structuredDataTemplates = new Map();
    this.performanceMetrics = new Map();
    this.coreWebVitalsData = [];
  }

  /**
   * 初始化 SEO 引擎
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('🎯 初始化企业级 SEO 引擎...');

      // 初始化结构化数据模板
      await this.initializeStructuredDataTemplates();

      // 生成初始站点地图（开发环境跳过，避免空sitemap错误）
      if (this.config.sitemap.enabled && process.env.NODE_ENV === 'production') {
        await this.generateSitemap();
      } else if (this.config.sitemap.enabled) {
        this.logger.debug('🗺️ 开发环境跳过站点地图生成，将在首次页面访问时生成');
      }

      // 启动性能监控
      if (this.config.monitoring.enableCoreWebVitals) {
        this.startCoreWebVitalsMonitoring();
      }

      this.logger.info('✅ 企业级 SEO 引擎初始化完成');
    } catch (error) {
      this.logger.error('❌ SEO 引擎初始化失败:', error);
      throw error;
    }
  }

  /**
   * 为页面优化 SEO
   */
  async optimizePage(url: string, context: RenderContext, result: RenderResult): Promise<RenderResult> {
    try {
      if (!this.config.enabled) {
        return result;
      }

      this.logger.debug(`🔍 优化页面 SEO: ${url}`);

      // 获取或生成页面数据
      const pageData = await this.getPageData(url, context);

      // 生成 Meta 标签
      const metaTags = this.generateMetaTags(pageData);

      // 生成 Open Graph 标签
      const openGraphTags = this.generateOpenGraphTags(pageData);

      // 生成 Twitter Card 标签
      const twitterCardTags = this.generateTwitterCardTags(pageData);

      // 生成结构化数据
      const structuredData = await this.generateStructuredData(pageData);

      // 生成性能优化标签
      const performanceTags = this.generatePerformanceTags(url);

      // 合并所有 SEO 标签
      const seoTags = [
        ...metaTags,
        ...openGraphTags,
        ...twitterCardTags,
        ...performanceTags,
      ].join('\n    ');

      // 将 SEO 标签插入 HTML
      const optimizedHTML = this.insertSEOTags(result.html, seoTags, structuredData);

      // 记录 SEO 指标
      this.recordSEOMetrics(url, pageData);

      return {
        ...result,
        html: optimizedHTML,
        meta: {
          ...result.meta,
          seoOptimized: true,
          seoScore: this.calculateSEOScore(pageData),
        },
      };
    } catch (error) {
      this.logger.error(`❌ 页面 SEO 优化失败: ${url}`, error);
      return result;
    }
  }

  /**
   * 获取页面数据
   */
  private async getPageData(url: string, context: RenderContext): Promise<SEOPageData> {
    // 检查缓存
    const cached = this.pageDataCache.get(url);
    if (cached) {
      return cached;
    }

    // 生成页面数据
    const pageData = await this.generatePageData(url, context);
    
    // 缓存页面数据
    this.pageDataCache.set(url, pageData);
    
    return pageData;
  }

  /**
   * 生成页面数据
   */
  private async generatePageData(url: string, context: RenderContext): Promise<SEOPageData> {
    // 根据路由分析页面类型和内容
    const pageType = this.analyzePageType(url);
    
    const pageData: SEOPageData = {
      url: this.buildFullURL(url),
      title: this.generateTitle(url, pageType),
      description: this.generateDescription(url, pageType),
      keywords: this.generateKeywords(url, pageType),
      image: this.generateImage(url, pageType),
      type: pageType,
      language: this.detectLanguage(url, context),
      publishedTime: this.getPublishedTime(url),
      modifiedTime: new Date().toISOString(),
    };

    return pageData;
  }

  /**
   * 分析页面类型
   */
  private analyzePageType(url: string): 'website' | 'article' | 'product' {
    if (url.includes('/blog/') || url.includes('/article/')) {
      return 'article';
    }
    if (url.includes('/product/') || url.includes('/shop/')) {
      return 'product';
    }
    return 'website';
  }

  /**
   * 生成页面标题
   */
  private generateTitle(url: string, pageType: string): string {
    // 根据路由生成智能标题
    const pathSegments = url.split('/').filter(Boolean);
    
    if (url === '/') {
      return this.config.meta.defaultTitle;
    }

    // 将路径转换为标题
    const pageTitle = pathSegments
      .map(segment => segment.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))
      .join(' - ');

    return this.config.meta.titleTemplate.replace('%s', pageTitle);
  }

  /**
   * 生成页面描述
   */
  private generateDescription(url: string, pageType: string): string {
    if (url === '/') {
      return this.config.meta.defaultDescription;
    }

    // 根据页面类型生成描述
    switch (pageType) {
      case 'article':
        return `Read our latest article about ${this.extractTopicFromURL(url)}. Expert insights and analysis.`;
      case 'product':
        return `Discover ${this.extractTopicFromURL(url)} and its features. High-quality products for your needs.`;
      default:
        return `Learn more about ${this.extractTopicFromURL(url)}. Professional services and solutions.`;
    }
  }

  /**
   * 从 URL 提取主题
   */
  private extractTopicFromURL(url: string): string {
    const pathSegments = url.split('/').filter(Boolean);
    return pathSegments[pathSegments.length - 1]?.replace(/-/g, ' ') || 'our services';
  }

  /**
   * 生成关键词
   */
  private generateKeywords(url: string, pageType: string): string[] {
    const baseKeywords = [...this.config.meta.keywords];
    const topicKeywords = this.extractTopicFromURL(url).split(' ');
    
    return [...baseKeywords, ...topicKeywords, pageType];
  }

  /**
   * 生成图片 URL
   */
  private generateImage(url: string, pageType: string): string {
    // 可以根据页面类型或内容生成特定图片
    return this.config.openGraph.defaultImage;
  }

  /**
   * 检测语言
   */
  private detectLanguage(url: string, context: RenderContext): string {
    // 从 URL 路径检测语言
    const pathLang = url.split('/')[1];
    if (this.config.supportedLanguages.includes(pathLang)) {
      return pathLang;
    }

    // 从请求头检测语言
    if (context.acceptLanguage) {
      const preferredLang = context.acceptLanguage.split(',')[0].split('-')[0];
      if (this.config.supportedLanguages.includes(preferredLang)) {
        return preferredLang;
      }
    }

    return this.config.defaultLanguage;
  }

  /**
   * 获取发布时间
   */
  private getPublishedTime(url: string): string | undefined {
    // 这里可以从 CMS、数据库或文件系统获取实际的发布时间
    // 当前简化实现
    return undefined;
  }

  /**
   * 构建完整 URL
   */
  private buildFullURL(url: string): string {
    return `${this.config.baseUrl}${url}`;
  }

  /**
   * 生成 Meta 标签
   */
  private generateMetaTags(pageData: SEOPageData): string[] {
    const tags: string[] = [];

    // 基础 Meta 标签
    tags.push(`<title>${pageData.title}</title>`);
    tags.push(`<meta name="description" content="${pageData.description}">`);
    
    if (pageData.keywords && pageData.keywords.length > 0) {
      tags.push(`<meta name="keywords" content="${pageData.keywords.join(', ')}">`);
    }

    tags.push(`<meta name="author" content="${this.config.meta.author}">`);
    tags.push(`<meta name="robots" content="${this.config.meta.robots}">`);
    
    // 语言标签
    tags.push(`<meta name="language" content="${pageData.language}">`);
    tags.push(`<html lang="${pageData.language}">`);

    // Canonical URL
    if (this.config.meta.canonical) {
      tags.push(`<link rel="canonical" href="${pageData.url}">`);
    }

    // 移动端优化
    tags.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    tags.push('<meta name="theme-color" content="#000000">');

    return tags;
  }

  /**
   * 生成 Open Graph 标签
   */
  private generateOpenGraphTags(pageData: SEOPageData): string[] {
    if (!this.config.openGraph.enabled) {
      return [];
    }

    const tags: string[] = [];

    tags.push(`<meta property="og:title" content="${pageData.title}">`);
    tags.push(`<meta property="og:description" content="${pageData.description}">`);
    tags.push(`<meta property="og:type" content="${pageData.type}">`);
    tags.push(`<meta property="og:url" content="${pageData.url}">`);
    tags.push(`<meta property="og:site_name" content="${this.config.openGraph.siteName}">`);
    tags.push(`<meta property="og:locale" content="${this.config.openGraph.locale}">`);

    if (pageData.image) {
      tags.push(`<meta property="og:image" content="${pageData.image}">`);
      tags.push(`<meta property="og:image:width" content="${this.config.openGraph.imageSize.width}">`);
      tags.push(`<meta property="og:image:height" content="${this.config.openGraph.imageSize.height}">`);
    }

    if (pageData.publishedTime) {
      tags.push(`<meta property="article:published_time" content="${pageData.publishedTime}">`);
    }

    if (pageData.modifiedTime) {
      tags.push(`<meta property="article:modified_time" content="${pageData.modifiedTime}">`);
    }

    return tags;
  }

  /**
   * 生成 Twitter Card 标签
   */
  private generateTwitterCardTags(pageData: SEOPageData): string[] {
    if (!this.config.twitter.enabled) {
      return [];
    }

    const tags: string[] = [];

    tags.push(`<meta name="twitter:card" content="${this.config.twitter.card}">`);
    tags.push(`<meta name="twitter:site" content="${this.config.twitter.site}">`);
    tags.push(`<meta name="twitter:creator" content="${this.config.twitter.creator}">`);
    tags.push(`<meta name="twitter:title" content="${pageData.title}">`);
    tags.push(`<meta name="twitter:description" content="${pageData.description}">`);

    if (pageData.image) {
      tags.push(`<meta name="twitter:image" content="${pageData.image}">`);
    }

    return tags;
  }

  /**
   * 生成性能优化标签
   */
  private generatePerformanceTags(url: string): string[] {
    if (!this.config.performance.enableResourceHints) {
      return [];
    }

    const tags: string[] = [];

    // DNS 预解析
    tags.push('<link rel="dns-prefetch" href="//fonts.googleapis.com">');
    tags.push('<link rel="dns-prefetch" href="//cdnjs.cloudflare.com">');

    // 预连接重要资源
    tags.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');

    // 预加载关键资源
    if (this.config.performance.enablePreloading) {
      tags.push('<link rel="preload" href="/fonts/main.woff2" as="font" type="font/woff2" crossorigin>');
      tags.push('<link rel="preload" href="/css/critical.css" as="style">');
    }

    return tags;
  }

  /**
   * 初始化结构化数据模板
   */
  private async initializeStructuredDataTemplates(): Promise<void> {
    if (!this.config.structuredData.enabled) {
      return;
    }

    // 网站结构化数据
    this.structuredDataTemplates.set('WebSite', {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      ...this.config.structuredData.website,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${this.config.baseUrl}/search?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    });

    // 组织结构化数据
    this.structuredDataTemplates.set('Organization', {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      ...this.config.structuredData.organization,
    });

    // 面包屑导航
    this.structuredDataTemplates.set('BreadcrumbList', {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [], // 动态生成
    });

    this.logger.debug('📋 结构化数据模板已初始化');
  }

  /**
   * 生成结构化数据
   */
  private async generateStructuredData(pageData: SEOPageData): Promise<any[]> {
    if (!this.config.structuredData.enabled) {
      return [];
    }

    const structuredDataList: any[] = [];

    // 添加网站数据
    structuredDataList.push(this.structuredDataTemplates.get('WebSite'));

    // 添加组织数据
    structuredDataList.push(this.structuredDataTemplates.get('Organization'));

    // 添加面包屑导航
    if (this.config.structuredData.breadcrumbs) {
      const breadcrumbs = this.generateBreadcrumbs(pageData.url);
      if (breadcrumbs.itemListElement.length > 0) {
        structuredDataList.push(breadcrumbs);
      }
    }

    // 根据页面类型添加特定数据
    switch (pageData.type) {
      case 'article':
        if (this.config.structuredData.articles) {
          structuredDataList.push(this.generateArticleStructuredData(pageData));
        }
        break;
      case 'product':
        if (this.config.structuredData.products) {
          structuredDataList.push(this.generateProductStructuredData(pageData));
        }
        break;
    }

    return structuredDataList.filter(Boolean);
  }

  /**
   * 生成面包屑导航
   */
  private generateBreadcrumbs(url: string): any {
    const breadcrumbs = this.structuredDataTemplates.get('BreadcrumbList');
    const pathSegments = url.split('/').filter(Boolean);
    
    const itemListElement = [];
    let currentPath = '';

    // 添加首页
    itemListElement.push({
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: this.config.baseUrl,
    });

    // 添加路径段
    pathSegments.forEach((segment, index) => {
      currentPath += `/${segment}`;
      itemListElement.push({
        '@type': 'ListItem',
        position: index + 2,
        name: segment.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        item: `${this.config.baseUrl}${currentPath}`,
      });
    });

    return {
      ...breadcrumbs,
      itemListElement,
    };
  }

  /**
   * 生成文章结构化数据
   */
  private generateArticleStructuredData(pageData: SEOPageData): any {
    return {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: pageData.title,
      description: pageData.description,
      url: pageData.url,
      datePublished: pageData.publishedTime,
      dateModified: pageData.modifiedTime,
      author: {
        '@type': 'Person',
        name: pageData.author || this.config.meta.author,
      },
      publisher: this.config.structuredData.organization,
      image: pageData.image,
      keywords: pageData.keywords,
    };
  }

  /**
   * 生成产品结构化数据
   */
  private generateProductStructuredData(pageData: SEOPageData): any {
    return {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: pageData.title,
      description: pageData.description,
      url: pageData.url,
      image: pageData.image,
      brand: {
        '@type': 'Brand',
        name: this.config.openGraph.siteName,
      },
    };
  }

  /**
   * 插入 SEO 标签到 HTML
   */
  private insertSEOTags(html: string, seoTags: string, structuredData: any[]): string {
    // 生成结构化数据脚本
    const structuredDataScript = structuredData.length > 0
      ? `<script type="application/ld+json">${JSON.stringify(structuredData, null, 2)}</script>`
      : '';

    // 查找 head 标签并插入 SEO 标签
    const headEndIndex = html.indexOf('</head>');
    if (headEndIndex !== -1) {
      return html.slice(0, headEndIndex) +
        '    ' + seoTags + '\n' +
        '    ' + structuredDataScript + '\n' +
        html.slice(headEndIndex);
    }

    return html;
  }

  /**
   * 计算 SEO 分数
   */
  private calculateSEOScore(pageData: SEOPageData): number {
    let score = 0;

    // 标题优化 (25分)
    if (pageData.title && pageData.title.length >= 30 && pageData.title.length <= 60) {
      score += 25;
    } else if (pageData.title) {
      score += 15;
    }

    // 描述优化 (25分)
    if (pageData.description && pageData.description.length >= 120 && pageData.description.length <= 160) {
      score += 25;
    } else if (pageData.description) {
      score += 15;
    }

    // 关键词优化 (20分)
    if (pageData.keywords && pageData.keywords.length >= 3) {
      score += 20;
    } else if (pageData.keywords && pageData.keywords.length > 0) {
      score += 10;
    }

    // 图片优化 (15分)
    if (pageData.image) {
      score += 15;
    }

    // 结构化数据 (15分)
    if (this.config.structuredData.enabled) {
      score += 15;
    }

    return Math.min(score, 100);
  }

  /**
   * 记录 SEO 指标
   */
  private recordSEOMetrics(url: string, pageData: SEOPageData): void {
    const score = this.calculateSEOScore(pageData);
    
    this.performanceMetrics.set(url, {
      score,
      title: pageData.title,
      description: pageData.description,
      keywords: pageData.keywords?.length || 0,
      lastOptimized: Date.now(),
    });
  }

  /**
   * 生成站点地图
   */
  async generateSitemap(routes?: string[]): Promise<string> {
    try {
      this.logger.debug('🗺️ 生成站点地图...');

      // 检查缓存
      const now = Date.now();
      if (this.sitemapCache && (now - this.sitemapLastGenerated) < (this.config.sitemap.cacheTimeout * 1000)) {
        return this.sitemapCache;
      }

      const sitemap = new SitemapStream({ hostname: this.config.baseUrl });

      // 如果没有提供路由，使用缓存的页面数据
      const pagesToInclude = routes || Array.from(this.pageDataCache.keys());

      for (const url of pagesToInclude) {
        // 检查是否应该排除
        const shouldExclude = this.config.sitemap.excludePatterns.some(pattern =>
          new RegExp(pattern.replace('*', '.*')).test(url)
        );

        if (shouldExclude) {
          continue;
        }

        // 获取优先级和更新频率
        const priority = this.getSitemapPriority(url);
        const changefreq = this.getSitemapChangeFreq(url);

        sitemap.write({
          url,
          priority,
          changefreq,
          lastmod: new Date().toISOString(),
        });
      }

      sitemap.end();
      
      const sitemapContent = (await streamToPromise(sitemap)).toString();
      
      // 缓存结果
      this.sitemapCache = sitemapContent;
      this.sitemapLastGenerated = now;

      this.logger.info(`✅ 站点地图已生成: ${pagesToInclude.length} 个页面`);
      return sitemapContent;
    } catch (error) {
      this.logger.error('❌ 站点地图生成失败:', error);
      throw error;
    }
  }

  /**
   * 获取站点地图优先级
   */
  private getSitemapPriority(url: string): number {
    for (const [pattern, priority] of Object.entries(this.config.sitemap.priority)) {
      if (pattern === '*' || new RegExp(pattern.replace('*', '.*')).test(url)) {
        return priority;
      }
    }
    return 0.5;
  }

  /**
   * 获取站点地图更新频率
   */
  private getSitemapChangeFreq(url: string): string {
    for (const [pattern, changefreq] of Object.entries(this.config.sitemap.changeFreq)) {
      if (pattern === '*' || new RegExp(pattern.replace('*', '.*')).test(url)) {
        return changefreq;
      }
    }
    return 'monthly';
  }

  /**
   * 生成 Robots.txt
   */
  generateRobotsTxt(): string {
    const lines = [
      'User-agent: *',
      'Allow: /',
      '',
      // 排除模式
      ...this.config.sitemap.excludePatterns.map(pattern => `Disallow: ${pattern}`),
      '',
      `Sitemap: ${this.config.baseUrl}/sitemap.xml`,
    ];

    return lines.join('\n');
  }

  /**
   * 启动核心 Web 指标监控
   */
  private startCoreWebVitalsMonitoring(): void {
    // 这里可以集成真实用户监控 (RUM)
    // 当前为演示实现
    this.logger.debug('📊 核心 Web 指标监控已启动');
  }

  /**
   * 记录核心 Web 指标
   */
  recordCoreWebVitals(url: string, metrics: any): void {
    this.coreWebVitalsData.push({
      url,
      metrics,
      timestamp: Date.now(),
    });

    // 保持最近1000条记录
    if (this.coreWebVitalsData.length > 1000) {
      this.coreWebVitalsData = this.coreWebVitalsData.slice(-1000);
    }
  }

  /**
   * 获取 SEO 指标
   */
  getSEOMetrics(): SEOMetrics {
    const pages = Array.from(this.performanceMetrics.values());
    const totalScore = pages.reduce((sum, page) => sum + page.score, 0);
    const avgScore = pages.length > 0 ? totalScore / pages.length : 0;

    // 统计问题
    const criticalIssues = pages.filter(page => page.score < 50).length;
    const totalIssues = pages.filter(page => page.score < 80).length;

    // 核心 Web 指标
    const recentMetrics = this.coreWebVitalsData.slice(-100);
    const avgCoreWebVitals = recentMetrics.length > 0 ? {
      lcp: recentMetrics.reduce((sum, m) => sum + (m.metrics.lcp || 0), 0) / recentMetrics.length,
      fid: recentMetrics.reduce((sum, m) => sum + (m.metrics.fid || 0), 0) / recentMetrics.length,
      cls: recentMetrics.reduce((sum, m) => sum + (m.metrics.cls || 0), 0) / recentMetrics.length,
    } : { lcp: 0, fid: 0, cls: 0 };

    return {
      pagesIndexed: pages.length,
      averagePageScore: Math.round(avgScore),
      totalIssues,
      criticalIssues,
      performanceScores: {
        averageLoadTime: 0, // 需要从实际指标获取
        coreWebVitals: avgCoreWebVitals,
      },
      sitemapStats: {
        totalPages: this.pageDataCache.size,
        lastGenerated: this.sitemapLastGenerated,
        errors: 0,
      },
    };
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.pageDataCache.clear();
    this.sitemapCache = null;
    this.sitemapLastGenerated = 0;
    this.logger.debug('🧹 SEO 缓存已清理');
  }

  /**
   * 关闭 SEO 引擎
   */
  async shutdown(): Promise<void> {
    this.logger.debug('🛑 关闭 SEO 引擎...');
    
    this.clearCache();
    this.performanceMetrics.clear();
    this.coreWebVitalsData = [];
    
    this.logger.debug('✅ SEO 引擎已关闭');
  }
}

/**
 * 工厂函数：创建企业级 SEO 引擎实例
 */
export function createEnterpriseSEOEngine(
  projectRoot: string,
  config: Partial<EnterpriseSEOConfig> = {}
): EnterpriseSEOEngine {
  return new EnterpriseSEOEngine(projectRoot, config);
}