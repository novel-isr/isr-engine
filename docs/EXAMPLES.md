# 示例代码集合

本文档提供了 Novel ISR Engine 的完整使用示例，涵盖从基础到高级的各种场景。

## 目录

- [快速开始示例](#快速开始示例)
- [企业级配置示例](#企业级配置示例)
- [React Server Components 示例](#react-server-components-示例)
- [缓存策略示例](#缓存策略示例)
- [SEO 优化示例](#seo-优化示例)
- [降级链示例](#降级链示例)
- [AppShell 示例](#appshell-示例)
- [性能监控示例](#性能监控示例)
- [实际项目示例](#实际项目示例)

## 快速开始示例

### 1. 最小化设置

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { createEnterpriseViteISRPlugin } from 'isr-engine';

export default defineConfig({
  plugins: [
    ...createEnterpriseViteISRPlugin()
  ]
});
```

```typescript
// src/main.ts
import { createEnterpriseApp } from 'isr-engine';

const app = await createEnterpriseApp();
await app.start(3000);

console.log('🚀 服务器启动在 http://localhost:3000');
```

### 2. 基础页面渲染

```typescript
// src/App.tsx
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import ProductPage from './pages/ProductPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/products/:id" element={<ProductPage />} />
    </Routes>
  );
}
```

```typescript
// src/pages/HomePage.tsx
import React from 'react';
import { ProductList } from '../components/server/ProductList';

export default function HomePage() {
  return (
    <div>
      <h1>欢迎来到小说评分网站</h1>
      <ProductList category="featured" />
    </div>
  );
}
```

## 企业级配置示例

### 1. 完整配置文件

```typescript
// novel-isr.config.ts
export default {
  // 基础配置
  mode: 'isr',
  
  // 开发环境配置
  dev: {
    port: 3000,
    host: '0.0.0.0',
    verbose: true,
    hmr: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  },
  
  // 企业级功能
  enterprise: {
    enabled: true,
    
    // 智能降级链
    fallbackChain: {
      enabled: true,
      strategies: [
        { 
          name: 'static', 
          priority: 1, 
          timeout: 500, 
          retries: 1 
        },
        { 
          name: 'cached', 
          priority: 2, 
          timeout: 200, 
          retries: 1 
        },
        { 
          name: 'regenerate', 
          priority: 3, 
          timeout: 5000, 
          retries: 2 
        },
        { 
          name: 'server', 
          priority: 4, 
          timeout: 8000, 
          retries: 1 
        },
        { 
          name: 'client', 
          priority: 5, 
          timeout: 1000, 
          retries: 0 
        }
      ],
      
      // 自适应学习
      adaptive: {
        enabled: true,
        learningRate: 0.1,
        performanceThreshold: 3000,
        minSampleSize: 100
      },
      
      // 熔断器
      circuit: {
        enabled: true,
        failureThreshold: 10,
        resetTimeout: 30000
      }
    },
    
    // 多层缓存
    cache: {
      multiLayer: true,
      compression: true,
      encryption: true,
      analytics: true,
      
      // L1 内存缓存
      l1: {
        maxSize: 1000,
        ttl: 300000,    // 5分钟
        algorithm: 'lru'
      },
      
      // L2 Redis缓存
      l2: {
        host: 'localhost',
        port: 6379,
        password: process.env.REDIS_PASSWORD,
        ttl: 3600000,   // 1小时
        maxRetries: 3
      },
      
      // L3 磁盘缓存
      l3: {
        directory: '.cache',
        maxSize: '10GB',
        ttl: 86400000,  // 24小时
        cleanupInterval: 3600000
      }
    },
    
    // 高级SEO
    seo: {
      advanced: true,
      structuredData: true,
      performance: true,
      multiLanguage: true,
      sitemap: {
        enabled: true,
        changefreq: 'daily',
        priority: 0.7
      }
    },
    
    // 性能监控
    monitoring: {
      detailed: true,
      realtime: true,
      alerts: {
        enabled: true,
        thresholds: {
          responseTime: 3000,
          errorRate: 0.05,
          memoryUsage: 0.8
        }
      },
      metrics: {
        enabled: true,
        interval: 10000,
        retention: '7d'
      }
    }
  },
  
  // React Server Components
  rsc: {
    enabled: true,
    maxWorkers: 4,
    cacheSize: 1000,
    componentsDir: 'src/components/server',
    vmConfig: {
      timeout: 10000,
      memoryLimit: '256MB',
      sandbox: true
    }
  },
  
  // 应用外壳
  appShell: {
    enabled: true,
    template: 'src/AppShell.tsx',
    entries: {
      main: 'src/App.tsx',
      admin: 'src/AdminApp.tsx',
      mobile: 'src/MobileApp.tsx'
    },
    preloadResources: [
      'fonts',
      'critical-css',
      'hero-images'
    ],
    caching: {
      enabled: true,
      ttl: 3600000
    }
  },
  
  // 构建配置
  build: {
    sourcemap: process.env.NODE_ENV === 'development',
    minify: process.env.NODE_ENV === 'production',
    splitting: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          ui: ['@mui/material', '@emotion/react']
        }
      }
    }
  },
  
  // 安全配置
  security: {
    csp: {
      enabled: true,
      policy: "default-src 'self'; img-src 'self' data: https:;"
    },
    rateLimit: {
      enabled: true,
      windowMs: 15 * 60 * 1000, // 15分钟
      max: 100 // 最大请求数
    }
  }
};
```

### 2. 环境变量配置

```bash
# .env.production
NODE_ENV=production
PORT=3000

# Redis配置
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# 数据库配置
DATABASE_URL=postgresql://user:pass@host:5432/db

# 监控配置
SENTRY_DSN=https://your-sentry-dsn
NEW_RELIC_LICENSE_KEY=your_newrelic_key

# CDN配置
CDN_URL=https://cdn.example.com
ASSET_PREFIX=/static

# 安全配置
SECRET_KEY=your_secret_key
ENCRYPTION_KEY=your_encryption_key
```

## React Server Components 示例

### 1. 基础 RSC 组件

```typescript
// src/components/server/BookList.tsx
import React from 'react';
import { Suspense } from 'react';
import { BookCard } from './BookCard';
import { BookSkeleton } from '../client/BookSkeleton';

interface Book {
  id: string;
  title: string;
  author: string;
  rating: number;
  coverImage: string;
}

// 异步服务端组件
export async function BookList({ 
  category, 
  limit = 10 
}: { 
  category: string; 
  limit?: number; 
}) {
  // 服务端数据获取
  const books = await fetchBooksByCategory(category, limit);
  
  return (
    <div className="book-grid">
      <h2>分类：{category}</h2>
      <Suspense fallback={<BookSkeleton count={limit} />}>
        {books.map((book: Book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </Suspense>
    </div>
  );
}

// 数据获取函数
async function fetchBooksByCategory(category: string, limit: number): Promise<Book[]> {
  const response = await fetch(`${process.env.API_BASE_URL}/books?category=${category}&limit=${limit}`, {
    // 启用缓存
    next: { revalidate: 300 } // 5分钟重新验证
  });
  
  if (!response.ok) {
    throw new Error(`获取书籍列表失败: ${response.status}`);
  }
  
  return response.json();
}
```

```typescript
// src/components/server/BookCard.tsx
import React from 'react';
import Link from 'next/link';
import { StarRating } from '../client/StarRating';

interface Book {
  id: string;
  title: string;
  author: string;
  rating: number;
  coverImage: string;
}

export async function BookCard({ book }: { book: Book }) {
  // 可以在这里获取额外的书籍详情
  const bookDetails = await fetchBookDetails(book.id);
  
  return (
    <div className="book-card">
      <Link href={`/books/${book.id}`}>
        <img 
          src={book.coverImage} 
          alt={book.title}
          loading="lazy"
        />
        <div className="book-info">
          <h3>{book.title}</h3>
          <p>作者：{book.author}</p>
          <div className="rating">
            <StarRating value={book.rating} readonly />
            <span>{book.rating}/5</span>
          </div>
          {bookDetails.tags && (
            <div className="tags">
              {bookDetails.tags.map(tag => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}

async function fetchBookDetails(bookId: string) {
  const response = await fetch(`${process.env.API_BASE_URL}/books/${bookId}/details`);
  return response.json();
}
```

### 2. 混合服务端/客户端组件

```typescript
// src/components/server/BookDetail.tsx
import React from 'react';
import { BookInteraction } from '../client/BookInteraction';
import { CommentList } from './CommentList';

export async function BookDetail({ bookId }: { bookId: string }) {
  const [book, userRating] = await Promise.all([
    fetchBook(bookId),
    fetchUserRating(bookId)
  ]);
  
  return (
    <article className="book-detail">
      <div className="book-header">
        <img src={book.coverImage} alt={book.title} />
        <div className="book-meta">
          <h1>{book.title}</h1>
          <p className="author">作者：{book.author}</p>
          <p className="description">{book.description}</p>
          
          {/* 客户端交互组件 */}
          <BookInteraction 
            bookId={bookId} 
            initialRating={userRating}
            averageRating={book.rating}
            totalRatings={book.ratingCount}
          />
        </div>
      </div>
      
      {/* 服务端评论列表 */}
      <CommentList bookId={bookId} />
    </article>
  );
}
```

```typescript
// src/components/client/BookInteraction.tsx
'use client';
import React, { useState } from 'react';
import { StarRating } from './StarRating';

interface BookInteractionProps {
  bookId: string;
  initialRating?: number;
  averageRating: number;
  totalRatings: number;
}

export function BookInteraction({ 
  bookId, 
  initialRating, 
  averageRating, 
  totalRatings 
}: BookInteractionProps) {
  const [userRating, setUserRating] = useState(initialRating || 0);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleRating = async (rating: number) => {
    setIsLoading(true);
    try {
      await submitRating(bookId, rating);
      setUserRating(rating);
    } catch (error) {
      console.error('提交评分失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBookmark = async () => {
    setIsLoading(true);
    try {
      if (isBookmarked) {
        await removeBookmark(bookId);
      } else {
        await addBookmark(bookId);
      }
      setIsBookmarked(!isBookmarked);
    } catch (error) {
      console.error('书签操作失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="book-interaction">
      <div className="rating-section">
        <h3>为这本书评分</h3>
        <StarRating 
          value={userRating}
          onChange={handleRating}
          disabled={isLoading}
        />
        {userRating > 0 && (
          <p>你的评分：{userRating}/5</p>
        )}
        <p>平均评分：{averageRating}/5 ({totalRatings} 人评分)</p>
      </div>
      
      <div className="actions">
        <button 
          onClick={handleBookmark}
          disabled={isLoading}
          className={`bookmark-btn ${isBookmarked ? 'bookmarked' : ''}`}
        >
          {isBookmarked ? '已收藏' : '收藏'}
        </button>
        <button className="share-btn">
          分享
        </button>
      </div>
    </div>
  );
}

async function submitRating(bookId: string, rating: number) {
  const response = await fetch(`/api/books/${bookId}/rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating })
  });
  
  if (!response.ok) {
    throw new Error('提交评分失败');
  }
  
  return response.json();
}

async function addBookmark(bookId: string) {
  const response = await fetch(`/api/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId })
  });
  
  if (!response.ok) {
    throw new Error('添加书签失败');
  }
}

async function removeBookmark(bookId: string) {
  const response = await fetch(`/api/bookmarks/${bookId}`, {
    method: 'DELETE'
  });
  
  if (!response.ok) {
    throw new Error('移除书签失败');
  }
}
```

## 缓存策略示例

### 1. 智能缓存标签

```typescript
// src/services/cacheService.ts
import { EnterpriseCacheEngine } from 'isr-engine';

export class BookCacheService {
  private cache: EnterpriseCacheEngine;

  constructor(cache: EnterpriseCacheEngine) {
    this.cache = cache;
  }

  // 缓存书籍列表
  async cacheBookList(category: string, books: Book[], page = 1) {
    const key = `books:list:${category}:${page}`;
    const tags = [
      'books',
      `category:${category}`,
      'list'
    ];

    await this.cache.set(key, books, {
      ttl: 300000,  // 5分钟
      tags,
      compress: true,
      priority: 'high'
    });
  }

  // 缓存单个书籍
  async cacheBook(book: Book) {
    const key = `book:${book.id}`;
    const tags = [
      'books',
      `book:${book.id}`,
      `author:${book.authorId}`,
      `category:${book.category}`,
      'detail'
    ];

    await this.cache.set(key, book, {
      ttl: 3600000, // 1小时
      tags,
      compress: true,
      encrypt: true,
      priority: 'high'
    });
  }

  // 缓存用户相关数据
  async cacheUserData(userId: string, bookId: string, data: any) {
    const key = `user:${userId}:book:${bookId}`;
    const tags = [
      'users',
      `user:${userId}`,
      `book:${bookId}`,
      'user-data'
    ];

    await this.cache.set(key, data, {
      ttl: 1800000,  // 30分钟
      tags,
      priority: 'normal'
    });
  }

  // 批量失效缓存
  async invalidateBook(bookId: string) {
    // 失效所有与该书籍相关的缓存
    await this.cache.invalidateByTags([`book:${bookId}`]);
  }

  async invalidateCategory(category: string) {
    // 失效该分类下的所有缓存
    await this.cache.invalidateByTags([`category:${category}`]);
  }

  async invalidateAuthor(authorId: string) {
    // 失效该作者的所有相关缓存
    await this.cache.invalidateByTags([`author:${authorId}`]);
  }

  // 获取缓存统计
  async getStats() {
    return this.cache.getStats();
  }
}
```

### 2. 条件缓存

```typescript
// src/middleware/cacheMiddleware.ts
export function createCacheMiddleware(cacheService: BookCacheService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { path, query, headers } = req;
    
    // 只缓存GET请求
    if (req.method !== 'GET') {
      return next();
    }
    
    // 构建缓存键
    const cacheKey = `request:${path}:${JSON.stringify(query)}`;
    
    // 检查用户状态决定缓存策略
    const isLoggedIn = headers.authorization ? true : false;
    const userAgent = headers['user-agent'] || '';
    const isMobile = /mobile|android|iphone/i.test(userAgent);
    
    // 个性化内容不缓存
    if (isLoggedIn && path.includes('/profile')) {
      return next();
    }
    
    // 检查缓存
    const cached = await cacheService.cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Time', cached.cachedAt);
      return res.json(cached.data);
    }
    
    // 继续处理请求
    res.locals.cacheKey = cacheKey;
    res.locals.cacheTags = [
      path.split('/')[1], // 第一级路径
      isMobile ? 'mobile' : 'desktop',
      isLoggedIn ? 'authenticated' : 'anonymous'
    ];
    
    next();
  };
}

// 响应缓存中间件
export function cacheResponse(cacheService: BookCacheService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.send;
    
    res.send = function(data) {
      const { cacheKey, cacheTags } = res.locals;
      
      if (cacheKey && res.statusCode === 200) {
        // 异步缓存，不阻塞响应
        process.nextTick(async () => {
          try {
            await cacheService.cache.set(cacheKey, {
              data: JSON.parse(data),
              cachedAt: new Date().toISOString()
            }, {
              ttl: 300000,
              tags: cacheTags
            });
          } catch (error) {
            console.error('缓存失败:', error);
          }
        });
        
        res.setHeader('X-Cache', 'MISS');
      }
      
      return originalSend.call(this, data);
    };
    
    next();
  };
}
```

## SEO 优化示例

### 1. 动态SEO配置

```typescript
// src/seo/seoConfig.ts
export const seoConfig = {
  // 默认配置
  defaults: {
    title: 'Novel Rating - 专业小说评分平台',
    description: '发现最好的小说，分享你的阅读体验。Novel Rating 提供专业的小说评分、评论和推荐服务。',
    keywords: ['小说评分', '书评', '小说推荐', '阅读社区'],
    author: 'Novel Rating Team',
    robots: 'index,follow',
    
    openGraph: {
      type: 'website',
      siteName: 'Novel Rating',
      locale: 'zh_CN',
      images: [
        {
          url: 'https://novel-rating.com/og-default.jpg',
          width: 1200,
          height: 630,
          alt: 'Novel Rating - 专业小说评分平台'
        }
      ]
    },
    
    twitter: {
      card: 'summary_large_image',
      site: '@novel_rating',
      creator: '@novel_rating'
    },
    
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      'name': 'Novel Rating',
      'url': 'https://novel-rating.com',
      'description': '专业小说评分平台',
      'potentialAction': {
        '@type': 'SearchAction',
        'target': 'https://novel-rating.com/search?q={search_term_string}',
        'query-input': 'required name=search_term_string'
      }
    }
  },
  
  // 页面特定配置
  pages: {
    // 首页
    '/': {
      title: 'Novel Rating - 发现最好的小说',
      description: '浏览热门小说、查看专业评分、发现你的下一本好书。加入我们的阅读社区，分享你的阅读体验。',
      keywords: ['热门小说', '小说排行榜', '新书推荐'],
      
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        'name': '首页',
        'description': '发现最好的小说',
        'mainEntity': {
          '@type': 'ItemList',
          'name': '热门小说列表',
          'numberOfItems': 20
        }
      }
    },
    
    // 书籍详情页
    '/books/[id]': {
      title: '{book.title} - {book.author} | Novel Rating',
      description: '{book.description}',
      keywords: ['{book.title}', '{book.author}', '书评', '小说评分'],
      
      openGraph: {
        type: 'book',
        book: {
          author: '{book.author}',
          isbn: '{book.isbn}',
          releaseDate: '{book.publishDate}',
          tags: '{book.genres}'
        },
        images: [
          {
            url: '{book.coverImage}',
            width: 600,
            height: 800,
            alt: '{book.title} - 封面'
          }
        ]
      },
      
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Book',
        'name': '{book.title}',
        'author': {
          '@type': 'Person',
          'name': '{book.author}'
        },
        'isbn': '{book.isbn}',
        'datePublished': '{book.publishDate}',
        'description': '{book.description}',
        'genre': '{book.genres}',
        'image': '{book.coverImage}',
        'aggregateRating': {
          '@type': 'AggregateRating',
          'ratingValue': '{book.rating}',
          'reviewCount': '{book.reviewCount}',
          'bestRating': '5',
          'worstRating': '1'
        },
        'offers': {
          '@type': 'Offer',
          'availability': 'https://schema.org/InStock',
          'price': '{book.price}',
          'priceCurrency': 'CNY'
        }
      }
    },
    
    // 作者页面
    '/authors/[id]': {
      title: '{author.name} - 作者档案 | Novel Rating',
      description: '了解作者 {author.name} 的作品、生平简介和读者评价。查看 {author.name} 的所有小说和最新资讯。',
      
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Person',
        'name': '{author.name}',
        'description': '{author.bio}',
        'image': '{author.avatar}',
        'url': 'https://novel-rating.com/authors/{author.id}',
        'sameAs': '{author.socialLinks}',
        'worksFor': {
          '@type': 'Organization',
          'name': '{author.publisher}'
        }
      }
    },
    
    // 分类页面
    '/categories/[category]': {
      title: '{category} 小说推荐 | Novel Rating',
      description: '发现最好的 {category} 小说。浏览 {category} 分类下的热门书籍、新书推荐和读者好评作品。',
      
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        'name': '{category} 小说分类',
        'description': '{category} 分类下的小说推荐',
        'mainEntity': {
          '@type': 'ItemList',
          'name': '{category} 小说列表'
        }
      }
    }
  }
};
```

### 2. SEO中间件

```typescript
// src/middleware/seoMiddleware.ts
import { EnterpriseSEOEngine } from 'isr-engine';
import { seoConfig } from '../seo/seoConfig';

export function createSEOMiddleware(seoEngine: EnterpriseSEOEngine) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { path, query } = req;
    
    // 获取页面数据
    const pageData = await getPageData(path, query);
    
    // 生成SEO标签
    const seoTags = await seoEngine.generateMetaTags(pageData);
    const structuredData = await seoEngine.generateStructuredData(pageData);
    
    // 添加到响应头部
    res.locals.seo = {
      tags: seoTags,
      structuredData,
      canonical: `https://novel-rating.com${path}`,
      alternates: generateAlternateLinks(path)
    };
    
    next();
  };
}

async function getPageData(path: string, query: any) {
  const pageConfig = findPageConfig(path);
  
  if (!pageConfig) {
    return {
      url: path,
      title: seoConfig.defaults.title,
      description: seoConfig.defaults.description
    };
  }
  
  // 根据路径获取具体数据
  switch (true) {
    case path.startsWith('/books/'):
      const bookId = path.split('/')[2];
      return await getBookPageData(bookId);
      
    case path.startsWith('/authors/'):
      const authorId = path.split('/')[2];
      return await getAuthorPageData(authorId);
      
    case path.startsWith('/categories/'):
      const category = path.split('/')[2];
      return await getCategoryPageData(category);
      
    default:
      return {
        url: path,
        title: seoConfig.defaults.title,
        description: seoConfig.defaults.description
      };
  }
}

async function getBookPageData(bookId: string) {
  const book = await fetchBook(bookId);
  
  return {
    url: `/books/${bookId}`,
    title: `${book.title} - ${book.author}`,
    description: book.description,
    keywords: [book.title, book.author, ...book.genres],
    image: book.coverImage,
    publishDate: book.publishDate,
    data: book
  };
}

function generateAlternateLinks(path: string) {
  const languages = ['zh-CN', 'en-US', 'ja-JP'];
  
  return languages.map(lang => ({
    hreflang: lang,
    href: `https://novel-rating.com/${lang}${path}`
  }));
}
```

## 降级链示例

### 1. 自定义降级策略

```typescript
// src/strategies/customStrategies.ts
import { FallbackStrategy, RenderContext, RenderResult } from 'isr-engine';

// 静态文件策略
export class StaticFileStrategy implements FallbackStrategy {
  name = 'static-file';
  priority = 1;
  timeout = 100;
  retries = 1;

  async healthCheck(): Promise<boolean> {
    // 检查静态文件目录是否可访问
    return fs.existsSync('./dist/static');
  }

  async execute(url: string, context: RenderContext): Promise<RenderResult> {
    const staticPath = `./dist/static${url}.html`;
    
    if (!fs.existsSync(staticPath)) {
      throw new Error('静态文件不存在');
    }
    
    const html = await fs.readFile(staticPath, 'utf-8');
    
    return {
      html,
      statusCode: 200,
      strategy: this.name,
      cached: true,
      renderTime: 10,
      headers: {
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': 'text/html; charset=utf-8'
      }
    };
  }
}

// CDN缓存策略
export class CDNCacheStrategy implements FallbackStrategy {
  name = 'cdn-cache';
  priority = 2;
  timeout = 200;
  retries = 1;
  
  private cdnUrls = [
    'https://cdn1.novel-rating.com',
    'https://cdn2.novel-rating.com'
  ];

  async execute(url: string, context: RenderContext): Promise<RenderResult> {
    const cacheKey = this.generateCacheKey(url, context);
    
    // 尝试从多个CDN节点获取
    for (const cdnUrl of this.cdnUrls) {
      try {
        const response = await fetch(`${cdnUrl}/cache/${cacheKey}`, {
          timeout: this.timeout
        });
        
        if (response.ok) {
          const data = await response.json();
          return {
            html: data.html,
            statusCode: 200,
            strategy: this.name,
            cached: true,
            renderTime: 50,
            headers: data.headers
          };
        }
      } catch (error) {
        continue; // 尝试下一个CDN节点
      }
    }
    
    throw new Error('CDN缓存未命中');
  }
  
  private generateCacheKey(url: string, context: RenderContext): string {
    const factors = [
      url,
      context.userAgent?.includes('Mobile') ? 'mobile' : 'desktop',
      context.locale || 'zh-CN'
    ];
    
    return btoa(factors.join('|'));
  }
}

// 预渲染策略
export class PreRenderStrategy implements FallbackStrategy {
  name = 'pre-render';
  priority = 3;
  timeout = 2000;
  retries = 2;
  
  private renderQueue = new Map<string, Promise<RenderResult>>();

  async execute(url: string, context: RenderContext): Promise<RenderResult> {
    // 检查是否正在渲染中
    if (this.renderQueue.has(url)) {
      return await this.renderQueue.get(url)!;
    }
    
    // 创建渲染任务
    const renderTask = this.performRender(url, context);
    this.renderQueue.set(url, renderTask);
    
    try {
      const result = await renderTask;
      
      // 异步缓存结果
      this.cacheResult(url, result);
      
      return result;
    } finally {
      this.renderQueue.delete(url);
    }
  }
  
  private async performRender(url: string, context: RenderContext): Promise<RenderResult> {
    const startTime = Date.now();
    
    // 模拟预渲染过程
    const html = await this.renderToString(url, context);
    
    return {
      html,
      statusCode: 200,
      strategy: this.name,
      cached: false,
      renderTime: Date.now() - startTime,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    };
  }
  
  private async renderToString(url: string, context: RenderContext): Promise<string> {
    // 实际的渲染逻辑
    return `<html><body>预渲染内容: ${url}</body></html>`;
  }
  
  private async cacheResult(url: string, result: RenderResult) {
    // 异步缓存到多层缓存系统
    try {
      await cache.set(`pre-render:${url}`, result, {
        ttl: 3600000, // 1小时
        tags: ['pre-render', url]
      });
    } catch (error) {
      console.error('缓存预渲染结果失败:', error);
    }
  }
}
```

### 2. 智能降级配置

```typescript
// src/config/fallbackConfig.ts
import { 
  StaticFileStrategy, 
  CDNCacheStrategy, 
  PreRenderStrategy 
} from '../strategies/customStrategies';

export function createIntelligentFallbackChain() {
  return {
    enabled: true,
    
    strategies: [
      // 1. 静态文件 (最快，适合不变内容)
      new StaticFileStrategy(),
      
      // 2. CDN缓存 (快速，适合热门内容)
      new CDNCacheStrategy(),
      
      // 3. 预渲染 (中等速度，适合个性化内容)
      new PreRenderStrategy(),
      
      // 4. ISR 重新生成 (较慢，适合过期内容)
      {
        name: 'isr-regenerate',
        priority: 4,
        timeout: 5000,
        retries: 2,
        execute: async (url, context) => {
          return await isrEngine.regenerate(url, context);
        }
      },
      
      // 5. 服务端渲染 (慢，适合动态内容)
      {
        name: 'ssr',
        priority: 5,
        timeout: 8000,
        retries: 1,
        execute: async (url, context) => {
          return await ssrRenderer.render(url, context);
        }
      },
      
      // 6. 客户端渲染 (最后备选)
      {
        name: 'csr-fallback',
        priority: 6,
        timeout: 1000,
        retries: 0,
        execute: async (url, context) => {
          return {
            html: generateCSRShell(url, context),
            statusCode: 200,
            strategy: 'csr-fallback',
            cached: false,
            renderTime: 50
          };
        }
      }
    ],
    
    // 自适应学习配置
    adaptive: {
      enabled: true,
      learningRate: 0.1,
      performanceThreshold: 3000,
      minSampleSize: 50,
      
      // 自定义权重调整
      weightAdjustment: {
        success: 1.1,      // 成功时权重增加
        failure: 0.8,      // 失败时权重减少
        timeout: 0.7,      // 超时时权重大幅减少
        performance: 1.2   // 性能优异时权重增加
      }
    },
    
    // 熔断器配置
    circuit: {
      enabled: true,
      failureThreshold: 10,        // 连续失败10次后熔断
      resetTimeout: 60000,         // 1分钟后尝试恢复
      halfOpenMaxCalls: 3,         // 半开状态最大调用次数
      rollingWindow: 600000,       // 10分钟滑动窗口
    },
    
    // 监控和告警
    monitoring: {
      enabled: true,
      metricsInterval: 10000,      // 10秒收集一次指标
      alertThresholds: {
        failureRate: 0.1,          // 失败率超过10%告警
        avgResponseTime: 5000,     // 平均响应时间超过5秒告警
        circuitOpenRate: 0.05      // 熔断率超过5%告警
      }
    }
  };
}

function generateCSRShell(url: string, context: RenderContext): string {
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Loading...</title>
      <style>
        .loading { 
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
        }
      </style>
    </head>
    <body>
      <div id="app">
        <div class="loading">
          <div>页面加载中...</div>
        </div>
      </div>
      <script>
        window.__INITIAL_STATE__ = ${JSON.stringify({ url, context })};
      </script>
      <script src="/static/js/app.js"></script>
    </body>
    </html>
  `;
}
```

## AppShell 示例

### 1. 共享 AppShell 模板

```typescript
// src/AppShell.tsx
import React from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Navigation } from './components/Navigation';

interface AppShellProps {
  children: React.ReactNode;
  entry: 'main' | 'admin' | 'mobile';
  theme?: 'light' | 'dark';
  lang?: string;
}

export function AppShell({ children, entry, theme = 'light', lang = 'zh-CN' }: AppShellProps) {
  return (
    <html lang={lang} data-theme={theme}>
      <head>
        {/* 预加载关键资源 */}
        <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/css/critical.css" as="style" />
        
        {/* 关键CSS */}
        <link rel="stylesheet" href="/css/critical.css" />
        
        {/* PWA配置 */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#1976d2" />
        
        {/* 根据入口加载不同的资源 */}
        {entry === 'admin' && <link rel="stylesheet" href="/css/admin.css" />}
        {entry === 'mobile' && <link rel="stylesheet" href="/css/mobile.css" />}
      </head>
      <body>
        <ErrorBoundary>
          <div id="app" className={`app-${entry}`}>
            {/* 根据入口显示不同的导航 */}
            {entry !== 'mobile' && <Header />}
            {entry === 'main' && <Navigation />}
            
            <main id="main-content">
              {children}
            </main>
            
            {entry !== 'admin' && <Footer />}
          </div>
        </ErrorBoundary>
        
        {/* 根据入口加载不同的脚本 */}
        <script src={`/js/${entry}.js`} defer></script>
        
        {/* 服务工作器注册 */}
        <script>{`
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
          }
        `}</script>
      </body>
    </html>
  );
}
```

### 2. 多入口配置

```typescript
// src/entries/MainApp.tsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from '../AppShell';
import { HomePage } from '../pages/HomePage';
import { BookPage } from '../pages/BookPage';
import { SearchPage } from '../pages/SearchPage';

export function MainApp() {
  return (
    <AppShell entry="main">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/books/:id" element={<BookPage />} />
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </BrowserRouter>
    </AppShell>
  );
}
```

```typescript
// src/entries/AdminApp.tsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from '../AppShell';
import { Dashboard } from '../pages/admin/Dashboard';
import { BookManagement } from '../pages/admin/BookManagement';
import { UserManagement } from '../pages/admin/UserManagement';

export function AdminApp() {
  return (
    <AppShell entry="admin" theme="dark">
      <BrowserRouter basename="/admin">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/books" element={<BookManagement />} />
          <Route path="/users" element={<UserManagement />} />
        </Routes>
      </BrowserRouter>
    </AppShell>
  );
}
```

```typescript
// src/entries/MobileApp.tsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from '../AppShell';
import { MobileHome } from '../pages/mobile/MobileHome';
import { MobileBook } from '../pages/mobile/MobileBook';
import { MobileProfile } from '../pages/mobile/MobileProfile';

export function MobileApp() {
  return (
    <AppShell entry="mobile">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<MobileHome />} />
          <Route path="/books/:id" element={<MobileBook />} />
          <Route path="/profile" element={<MobileProfile />} />
        </Routes>
      </BrowserRouter>
    </AppShell>
  );
}
```

## 性能监控示例

### 1. 自定义指标收集

```typescript
// src/monitoring/metricsCollector.ts
import { MetricsCollector } from 'isr-engine';

export class CustomMetricsCollector extends MetricsCollector {
  // 收集业务指标
  static recordBookView(bookId: string, userId?: string) {
    this.increment('book.views', {
      book_id: bookId,
      user_type: userId ? 'authenticated' : 'anonymous'
    });
  }
  
  static recordSearch(query: string, resultsCount: number, userId?: string) {
    this.increment('search.queries', {
      has_results: resultsCount > 0 ? 'true' : 'false',
      user_type: userId ? 'authenticated' : 'anonymous'
    });
    
    this.histogram('search.results_count', resultsCount);
    
    // 记录搜索词热度
    this.increment('search.terms', {
      query: query.toLowerCase()
    });
  }
  
  static recordRating(bookId: string, rating: number, userId: string) {
    this.increment('book.ratings', {
      book_id: bookId,
      rating: rating.toString()
    });
    
    this.histogram('rating.value', rating, {
      book_id: bookId
    });
  }
  
  static recordPageLoadTime(route: string, loadTime: number, strategy: string) {
    this.histogram('page.load_time', loadTime, {
      route,
      strategy
    });
    
    // 记录加载策略使用情况
    this.increment('rendering.strategy', {
      strategy,
      route
    });
  }
  
  static recordCacheHit(layer: 'l1' | 'l2' | 'l3', key: string) {
    this.increment('cache.hits', {
      layer,
      key_type: this.getKeyType(key)
    });
  }
  
  static recordCacheMiss(layer: 'l1' | 'l2' | 'l3', key: string) {
    this.increment('cache.misses', {
      layer,
      key_type: this.getKeyType(key)
    });
  }
  
  static recordError(error: Error, context: any) {
    this.increment('errors.total', {
      error_type: error.constructor.name,
      route: context.route || 'unknown',
      user_agent: context.userAgent ? 'mobile' : 'desktop'
    });
  }
  
  private static getKeyType(key: string): string {
    if (key.startsWith('book:')) return 'book';
    if (key.startsWith('user:')) return 'user';
    if (key.startsWith('search:')) return 'search';
    return 'other';
  }
}
```

### 2. 实时监控面板

```typescript
// src/monitoring/dashboard.ts
export class MonitoringDashboard {
  private metricsInterval: NodeJS.Timeout;
  private alertRules: AlertRule[];
  
  constructor() {
    this.alertRules = [
      {
        name: '错误率过高',
        condition: (metrics) => metrics.errorRate > 0.05,
        action: (metrics) => this.sendAlert('高错误率告警', `当前错误率: ${metrics.errorRate * 100}%`)
      },
      {
        name: '响应时间过长',
        condition: (metrics) => metrics.avgResponseTime > 5000,
        action: (metrics) => this.sendAlert('响应时间告警', `平均响应时间: ${metrics.avgResponseTime}ms`)
      },
      {
        name: '缓存命中率过低',
        condition: (metrics) => metrics.cacheHitRate < 0.7,
        action: (metrics) => this.sendAlert('缓存命中率告警', `命中率: ${metrics.cacheHitRate * 100}%`)
      }
    ];
  }
  
  start() {
    this.metricsInterval = setInterval(() => {
      this.collectAndAnalyzeMetrics();
    }, 30000); // 每30秒检查一次
  }
  
  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
  
  private async collectAndAnalyzeMetrics() {
    const metrics = await this.getMetrics();
    
    // 检查告警规则
    for (const rule of this.alertRules) {
      if (rule.condition(metrics)) {
        rule.action(metrics);
      }
    }
    
    // 生成报告
    this.generateReport(metrics);
  }
  
  private async getMetrics() {
    const rawMetrics = CustomMetricsCollector.getMetrics();
    
    return {
      timestamp: Date.now(),
      
      // 性能指标
      avgResponseTime: this.calculateAverage(rawMetrics.histograms['page.load_time']),
      p95ResponseTime: this.calculatePercentile(rawMetrics.histograms['page.load_time'], 95),
      requestsPerSecond: this.calculateRate(rawMetrics.counters['requests.total']),
      
      // 错误指标
      errorRate: this.calculateRate(rawMetrics.counters['errors.total']) / 
                 this.calculateRate(rawMetrics.counters['requests.total']),
      
      // 缓存指标
      cacheHitRate: this.calculateCacheHitRate(rawMetrics),
      
      // 业务指标
      bookViews: rawMetrics.counters['book.views'] || 0,
      searchQueries: rawMetrics.counters['search.queries'] || 0,
      userRatings: rawMetrics.counters['book.ratings'] || 0,
      
      // 渲染策略分布
      strategyDistribution: this.calculateStrategyDistribution(rawMetrics)
    };
  }
  
  private calculateCacheHitRate(metrics: any) {
    const hits = (metrics.counters['cache.hits.l1'] || 0) +
                 (metrics.counters['cache.hits.l2'] || 0) +
                 (metrics.counters['cache.hits.l3'] || 0);
    
    const total = hits + 
                 (metrics.counters['cache.misses.l1'] || 0) +
                 (metrics.counters['cache.misses.l2'] || 0) +
                 (metrics.counters['cache.misses.l3'] || 0);
    
    return total > 0 ? hits / total : 0;
  }
  
  private calculateStrategyDistribution(metrics: any) {
    const strategies = ['static', 'cached', 'regenerate', 'server', 'client'];
    const total = strategies.reduce((sum, strategy) => {
      return sum + (metrics.counters[`rendering.strategy.${strategy}`] || 0);
    }, 0);
    
    return strategies.reduce((dist, strategy) => {
      const count = metrics.counters[`rendering.strategy.${strategy}`] || 0;
      dist[strategy] = total > 0 ? count / total : 0;
      return dist;
    }, {} as Record<string, number>);
  }
  
  private async sendAlert(title: string, message: string) {
    // 发送告警到多个渠道
    await Promise.all([
      this.sendSlackAlert(title, message),
      this.sendEmailAlert(title, message),
      this.logAlert(title, message)
    ]);
  }
  
  private async sendSlackAlert(title: string, message: string) {
    // Slack 集成
  }
  
  private async sendEmailAlert(title: string, message: string) {
    // 邮件告警
  }
  
  private logAlert(title: string, message: string) {
    console.error(`[ALERT] ${title}: ${message}`);
  }
  
  private generateReport(metrics: any) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        health: this.calculateHealthScore(metrics),
        performance: metrics.avgResponseTime < 3000 ? 'good' : 'poor',
        availability: metrics.errorRate < 0.01 ? 'high' : 'medium'
      },
      metrics
    };
    
    // 保存报告
    this.saveReport(report);
  }
  
  private calculateHealthScore(metrics: any): number {
    let score = 100;
    
    // 响应时间影响 (0-30分)
    if (metrics.avgResponseTime > 5000) score -= 30;
    else if (metrics.avgResponseTime > 3000) score -= 15;
    else if (metrics.avgResponseTime > 1000) score -= 5;
    
    // 错误率影响 (0-30分)
    if (metrics.errorRate > 0.05) score -= 30;
    else if (metrics.errorRate > 0.01) score -= 15;
    else if (metrics.errorRate > 0.005) score -= 5;
    
    // 缓存命中率影响 (0-20分)
    if (metrics.cacheHitRate < 0.5) score -= 20;
    else if (metrics.cacheHitRate < 0.7) score -= 10;
    else if (metrics.cacheHitRate < 0.8) score -= 5;
    
    return Math.max(0, score);
  }
  
  private saveReport(report: any) {
    // 保存到时间序列数据库或日志文件
    console.log('Performance Report:', JSON.stringify(report, null, 2));
  }
}

interface AlertRule {
  name: string;
  condition: (metrics: any) => boolean;
  action: (metrics: any) => void;
}
```

## 实际项目示例

### 1. 小说评分网站完整示例

```typescript
// vite.config.ts - 完整配置
import { defineConfig } from 'vite';
import { createEnterpriseViteISRPlugin } from 'isr-engine';
import path from 'path';

export default defineConfig({
  plugins: [
    ...createEnterpriseViteISRPlugin({
      // RSC配置
      rsc: {
        enabled: true,
        componentsDir: 'src/components/server',
        manifest: true
      },
      
      // AppShell配置
      appShell: {
        enabled: true,
        entries: {
          main: 'src/entries/MainApp.tsx',
          admin: 'src/entries/AdminApp.tsx',
          mobile: 'src/entries/MobileApp.tsx'
        }
      },
      
      // 企业级功能
      enterprise: {
        fallbackChain: true,
        multiLayerCache: true,
        advancedSEO: true,
        monitoring: true
      },
      
      // 构建优化
      build: {
        sourcemap: process.env.NODE_ENV === 'development',
        minify: process.env.NODE_ENV === 'production',
        splitting: true,
        rollupOptions: {
          output: {
            manualChunks: {
              vendor: ['react', 'react-dom', 'react-router-dom'],
              ui: ['@mui/material', '@emotion/react', '@emotion/styled'],
              utils: ['lodash', 'date-fns', 'axios']
            }
          }
        }
      }
    })
  ],
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@pages': path.resolve(__dirname, 'src/pages'),
      '@utils': path.resolve(__dirname, 'src/utils')
    }
  },
  
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
});
```

```typescript
// src/main.ts - 应用启动
import { createEnterpriseApp } from 'isr-engine';
import config from '../novel-isr.config';
import { CustomMetricsCollector } from './monitoring/metricsCollector';
import { MonitoringDashboard } from './monitoring/dashboard';

async function startApplication() {
  console.log('🚀 启动 Novel Rating 应用...');
  
  // 创建企业级应用
  const app = await createEnterpriseApp({
    config,
    mode: process.env.NODE_ENV as 'development' | 'production',
    features: {
      rsc: true,
      multiCache: true,
      advancedSEO: true,
      monitoring: true,
      appShell: true
    }
  });
  
  // 启动监控
  const dashboard = new MonitoringDashboard();
  dashboard.start();
  
  // 启动应用
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await app.start(port);
  
  console.log(`✅ 服务器成功启动在 http://localhost:${port}`);
  console.log('📊 监控面板已启用');
  
  // 优雅关闭
  process.on('SIGTERM', async () => {
    console.log('📴 正在关闭服务器...');
    dashboard.stop();
    await app.shutdown();
    process.exit(0);
  });
}

// 错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
  CustomMetricsCollector.recordError(reason as Error, { source: 'unhandledRejection' });
});

process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  CustomMetricsCollector.recordError(error, { source: 'uncaughtException' });
  process.exit(1);
});

startApplication().catch((error) => {
  console.error('❌ 应用启动失败:', error);
  process.exit(1);
});
```

这个完整的示例展示了如何在实际项目中使用 Novel ISR Engine 的所有企业级功能。通过这些示例，你可以快速理解和应用框架的各种特性。