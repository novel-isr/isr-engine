/**
 * SEO 默认配置
 */

import type { SEOConfig, DeepPartial } from './types';

/** 默认 SEO 配置 */
export const DEFAULT_SEO_CONFIG: SEOConfig = {
  enabled: true,
  baseUrl: process.env.BASE_URL || '',
  siteName: process.env.SITE_NAME || 'My App',
  defaultLanguage: 'zh',
  supportedLanguages: ['zh', 'en'],

  defaultTitle: process.env.SITE_TITLE || 'My App',
  defaultDescription: process.env.SITE_DESCRIPTION || '',
  titleTemplate: `%s | ${process.env.SITE_NAME || 'My App'}`,
  keywords: [],
  author: '',
  robots: 'index,follow',

  sitemap: {
    enabled: true,
    priority: {
      '/': 1.0,
      '/blog/*': 0.7,
      '*': 0.5,
    },
    changeFreq: {
      '/': 'daily',
      '/blog/*': 'weekly',
      '*': 'monthly',
    },
    excludePatterns: ['/admin/*', '/api/*'],
    cacheTimeout: 3600,
  },

  openGraph: {
    enabled: true,
    locale: 'zh_CN',
    defaultImage: '/images/og-default.jpg',
  },

  twitter: {
    enabled: true,
    card: 'summary_large_image',
    site: '',
  },

  structuredData: {
    enabled: true,
    organizationLogo: '',
  },
};

/** 深度合并配置 */
export function mergeSEOConfig(base: SEOConfig, override: DeepPartial<SEOConfig>): SEOConfig {
  return {
    ...base,
    ...override,
    sitemap: { ...base.sitemap, ...override.sitemap },
    openGraph: { ...base.openGraph, ...override.openGraph },
    twitter: { ...base.twitter, ...override.twitter },
    structuredData: { ...base.structuredData, ...override.structuredData },
  } as SEOConfig;
}
