# ISR (增量静态再生) 核心设计原理

## 什么是 ISR？

ISR (Incremental Static Regeneration) 是一种混合渲染策略，它结合了静态站点生成 (SSG) 的性能优势和服务端渲染 (SSR) 的动态性。

## ISR 的核心工作原理

### 1. 基本概念

ISR 允许你在构建时生成静态页面，然后在运行时按需更新这些页面，而不需要重新构建整个站点。

```
传统 SSG: 构建时生成 → 静态文件 → 用户访问
传统 SSR: 用户访问 → 实时渲染 → 返回页面

ISR: 构建时生成 → 静态文件 → 用户访问 → 后台更新 → 新的静态文件
```

### 2. ISR 的三个核心阶段

#### 阶段 1: 初始生成 (Initial Generation)

```typescript
// 在首次请求时或构建时生成页面
async regenerate(url: string, context: RenderContext): Promise<RenderResult> {
  // 1. 调用服务端渲染函数
  const { render } = await import(this.getServerEntryPath());
  const result = await render(url, context.manifest);

  // 2. 保存到 ISR 缓存
  await this.saveToISRCache(url, result);

  // 3. 返回渲染结果
  return result;
}
```

#### 阶段 2: 缓存服务 (Cache Serving)

```typescript
// 从缓存提供页面，检查是否需要重新验证
async serveCached(url: string, context: RenderContext): Promise<RenderResult> {
  const cachedPath = this.getISRCachePath(url);
  const metadataPath = this.getISRMetadataPath(url);

  // 1. 检查缓存是否存在
  if (!await this.fileExists(cachedPath)) {
    return await this.regenerate(url, context);
  }

  // 2. 读取元数据
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8'));

  // 3. 检查是否需要重新验证
  if (this.shouldRevalidate(url, metadata)) {
    if (this.config.isr.backgroundRevalidation) {
      // 后台重新生成，立即返回缓存版本
      this.scheduleBackgroundRevalidation(url, context);
    } else {
      // 阻塞式重新生成
      return await this.regenerate(url, context);
    }
  }

  // 4. 返回缓存的内容
  const html = await fs.promises.readFile(cachedPath, 'utf-8');
  return { html, fromCache: true };
}
```

#### 阶段 3: 后台重新验证 (Background Revalidation)

```typescript
// 在后台异步更新页面，不阻塞用户请求
scheduleBackgroundRevalidation(url: string, context: RenderContext): void {
  setImmediate(async () => {
    try {
      await this.regenerate(url, context);
      this.logger.debug(`Background revalidation completed: ${url}`);
    } catch (error) {
      this.logger.error(`Background revalidation failed for ${url}:`, error);
    }
  });
}
```

### 3. ISR 缓存文件结构

```
project-root/
└── .isr-cache/
    ├── index.html              # 首页的缓存内容
    ├── index.meta.json         # 首页的元数据
    ├── about.html              # /about 页面的缓存内容
    ├── about.meta.json         # /about 页面的元数据
    ├── posts_123.html          # /posts/123 页面的缓存内容
    └── posts_123.meta.json     # /posts/123 页面的元数据
```

#### 元数据文件结构

```json
{
  "url": "/posts/123",
  "generated": 1640995200000,    // 生成时间戳
  "statusCode": 200,
  "helmet": {                    // SEO 头信息
    "title": "文章标题",
    "meta": [...]
  },
  "preloadLinks": "<link rel='preload'...>",
  "size": 15420                  // 文件大小
}
```

### 4. 重新验证策略

#### 时间基础的重新验证

```typescript
shouldRevalidate(url: string, metadata: Record<string, any>): boolean {
  if (!metadata.generated) return true;

  const now = Date.now();
  const revalidateTime = this.config.isr.revalidate * 1000; // 转换为毫秒

  // 如果超过了重新验证时间，则需要更新
  return (now - metadata.generated) > revalidateTime;
}
```

#### 配置示例

```typescript
// ssr.config.ts
export default {
  mode: 'isr',
  isr: {
    revalidate: 3600, // 1小时后重新验证
    backgroundRevalidation: true, // 启用后台重新验证
  },
  routes: {
    '/': 'ssg', // 首页使用 SSG
    '/posts/*': 'isr', // 文章页面使用 ISR
    '/api/*': 'ssr', // API 路由使用 SSR
  },
};
```

## ISR 的优势

### 1. 性能优势

- **首次访问**: 如果页面已缓存，响应时间接近静态文件服务
- **后续访问**: 即使需要更新，用户也能立即获得缓存版本
- **CDN 友好**: 生成的静态文件可以被 CDN 缓存

### 2. 灵活性优势

- **按需生成**: 只有被访问的页面才会生成
- **动态更新**: 内容更新不需要重新构建整个站点
- **降级支持**: 如果 ISR 失败，自动降级到 SSR

### 3. 开发体验优势

- **零配置**: 默认配置即可工作
- **热更新**: 开发模式下支持热模块替换
- **监控友好**: 内置统计和监控功能

## ISR 与其他渲染模式的对比

| 特性         | SSG        | ISR        | SSR        | CSR        |
| ------------ | ---------- | ---------- | ---------- | ---------- |
| 首次加载速度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐     | ⭐⭐       |
| 内容新鲜度   | ⭐         | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 服务器负载   | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐   | ⭐⭐       | ⭐⭐⭐⭐⭐ |
| SEO 友好     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐       |
| 构建时间     | ⭐⭐       | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 扩展性       | ⭐⭐       | ⭐⭐⭐⭐   | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ |

## ISR 的实际应用场景

### 1. 博客和新闻网站

```typescript
// 配置示例
routes: {
  '/': 'ssg',                    // 首页静态生成
  '/posts': 'isr',               // 文章列表页面，1小时更新
  '/posts/*': 'isr',             // 单篇文章，6小时更新
  '/categories/*': 'isr'         // 分类页面，2小时更新
}
```

### 2. 电商网站

```typescript
// 配置示例
routes: {
  '/': 'ssg',                    // 首页
  '/products': 'isr',            // 产品列表，30分钟更新
  '/products/*': 'isr',          // 产品详情，1小时更新
  '/cart': 'ssr',               // 购物车，实时渲染
  '/checkout': 'ssr'             // 结账页面，实时渲染
}
```

### 3. 文档网站

```typescript
// 配置示例
routes: {
  '/': 'ssg',                    // 首页
  '/docs': 'ssg',               // 文档首页
  '/docs/*': 'isr',             // 文档页面，24小时更新
  '/api-reference/*': 'isr'     // API 文档，12小时更新
}
```

## ISR 的监控和调试

### 1. 内置监控端点

```bash
# 查看 ISR 统计
curl http://localhost:3000/ssr-stats

# 查看缓存状态
curl http://localhost:3000/cache-stats

# 清理 ISR 缓存
curl -X POST http://localhost:3000/cache/clear
```

### 2. 响应头信息

```
X-SSR-Mode: isr
X-SSR-Strategy: cached
X-SSR-Cache: HIT
X-SSR-Timestamp: 1640995200000
```

### 3. 日志信息

```
[ISR] Cache hit for: /posts/123
[ISR] Background revalidation scheduled: /posts/123
[ISR] Cache updated: /posts/123
```

## ISR 的最佳实践

### 1. 合理设置重新验证时间

- **高频更新内容**: 5-30分钟
- **中频更新内容**: 1-6小时
- **低频更新内容**: 12-24小时

### 2. 启用后台重新验证

```typescript
isr: {
  backgroundRevalidation: true; // 推荐启用
}
```

### 3. 监控缓存命中率

- 目标: 缓存命中率 > 80%
- 如果命中率过低，考虑增加重新验证时间

### 4. 合理的降级策略

```
ISR缓存 → ISR重新生成 → SSR渲染 → CSR降级
```

## 总结

ISR 是一种强大的渲染策略，它在性能和灵活性之间找到了完美的平衡点。通过智能的缓存和重新验证机制，ISR 能够提供接近静态站点的性能，同时保持内容的新鲜度。

**ISR 的核心价值**:

1. **用户体验**: 快速的页面加载
2. **开发体验**: 灵活的内容更新
3. **运维体验**: 低服务器负载和高可用性

这就是为什么 ISR 成为现代 Web 应用的首选渲染策略的原因。
