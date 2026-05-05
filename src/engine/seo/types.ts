/**
 * SEO 模块类型定义
 */

/** SEO 引擎配置 */
export interface SEOConfig {
  /** 站点基础 URL */
  baseUrl: string;
  /** 站点名称 */
  siteName: string;
  /** 默认语言 */
  defaultLanguage: string;
  /** 支持的语言列表 */
  supportedLanguages: string[];

  /** 默认标题 */
  defaultTitle: string;
  /** 默认描述 */
  defaultDescription: string;
  /** 标题模板，%s 为页面标题占位符 */
  titleTemplate: string;
  /** 关键词 */
  keywords: string[];
  /** 作者 */
  author: string;
  /** Robots 指令 */
  robots: string;

  /** 站点地图配置 */
  sitemap: {
    /** URL 优先级映射 (pattern -> priority) */
    priority: Record<string, number>;
    /** URL 更新频率映射 (pattern -> changefreq) */
    changeFreq: Record<string, string>;
    /** 排除的 URL 模式 */
    excludePatterns: string[];
    /** 缓存超时时间（秒） */
    cacheTimeout: number;
  };

  /** Open Graph 配置 */
  openGraph: {
    enabled: boolean;
    locale: string;
    defaultImage: string;
  };

  /** Twitter Cards 配置 */
  twitter: {
    enabled: boolean;
    card: string;
    site: string;
  };

  /** 结构化数据配置 */
  structuredData: {
    enabled: boolean;
    organizationLogo?: string;
  };
}

/** 页面 SEO 数据 */
export interface SEOPageData {
  url: string;
  title: string;
  description: string;
  keywords?: string[];
  image?: string;
  type: 'website' | 'article' | 'product';
  language: string;
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
}

/**
 * 深度部分类型
 * 数组保持原样不递归（避免破坏 readonly tuple / 数组泛型推断）
 */
export type DeepPartial<T> = T extends unknown[]
  ? T
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;
