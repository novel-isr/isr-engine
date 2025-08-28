# Novel ISR 引擎架构设计文档

## 1. 系统概述

Novel ISR 引擎是一个企业级的增量静态再生（ISR）渲染引擎，采用现代化的 TypeScript + Express + Vite 技术栈构建。该引擎实现了智能的渲染策略降级链：**ISR → SSR → CSR**，确保在任何情况下都能为用户提供可用的服务。

### 1.1 核心设计理念

- **性能优先**：ISR 作为主要渲染模式，结合静态生成的性能与服务端渲染的灵活性
- **自动降级**：智能降级链确保高可用性，对用户完全透明
- **企业级**：完整的类型安全、监控、缓存、SEO 优化等企业级功能
- **开发友好**：零配置启动，热模块替换，完整的开发工具链

### 1.2 技术栈

- **TypeScript**: 完整类型安全，企业级代码质量
- **Express**: 企业级 Web 服务器框架
- **Vite**: 现代化构建工具，支持 HMR 和双端构建
- **Node.js**: 18+ 运行时环境

## 2. 架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Novel ISR Engine                        │
├─────────────────────────────────────────────────────────────┤
│  HTTP Request → Express Server → SSR Engine → Response     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Engines   │  │   Modules   │  │   Utils     │        │
│  │             │  │             │  │             │        │
│  │ SSREngine   │  │ ISRModule   │  │ CacheManager│        │
│  │ SSRFactory  │  │ SSGModule   │  │ RouteManager│        │
│  │ RenderMode  │  │ SEOModule   │  │ Logger      │        │
│  │             │  │ CSRFallback │  │             │        │
│  └─────────────┘  │ SpiderEngine│  └─────────────┘        │
│                   └─────────────┘                          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Config    │  │   Plugin    │  │   Cache     │        │
│  │             │  │             │  │             │        │
│  │ Enterprise  │  │ ViteSSR     │  │ Memory      │        │
│  │ Config      │  │ Plugin      │  │ FileSystem  │        │
│  │             │  │             │  │ Redis       │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 目录结构设计

```
isr-engine/
├── engines/          # 核心引擎层
│   ├── SSREngine.ts     # 主渲染引擎（Express服务器 + 渲染逻辑）
│   ├── SSRFactory.ts    # 工厂类（NPM包入口点）
│   └── RenderMode.ts    # 渲染模式管理器
├── modules/          # 功能模块层
│   ├── ISRModule.ts     # ISR 增量静态再生实现
│   ├── SSGModule.ts     # SSG 静态站点生成实现
│   ├── SEOModule.ts     # SEO 优化（robots.txt, sitemap.xml）
│   ├── CSRFallback.ts   # CSR 客户端渲染降级
│   └── SpiderEngine.ts  # SEO 爬虫引擎
├── cache/            # 缓存管理层
│   └── CacheManager.ts  # 多策略缓存管理（内存/文件/Redis）
├── route/            # 路由管理层
│   └── RouteManager.ts  # 智能路由策略选择
├── plugin/           # Vite 插件层
│   └── ViteSSRPlugin.ts # Vite 集成插件
├── config/           # 配置管理层
│   ├── EnterpriseConfig.ts # 企业级配置管理
│   └── SSRConfig.ts     # 基础配置类
├── utils/            # 工具层
│   └── Logger.ts        # 日志系统
├── cli/              # 命令行工具
│   └── cli.ts           # CLI 入口
└── types.ts          # 类型定义
```

## 3. 核心模块详细设计

### 3.1 SSREngine - 核心渲染引擎

**职责**：

- 创建和管理 Express 服务器
- 协调各个渲染模块
- 实现智能降级链
- 提供监控和统计接口

**关键实现**：

```typescript
export default class SSREngine {
  private expressApp?: Express; // Express 应用实例
  private httpServer?: Server; // HTTP 服务器实例
  private viteServer?: ViteDevServer; // Vite 开发服务器
  private renderMode: RenderMode; // 渲染模式管理器
  private cache: CacheManager; // 缓存管理器
  private isrModule: ISRModule; // ISR 模块
  private ssgModule: SSGModule; // SSG 模块
  private csrFallback: CSRFallback; // CSR 降级模块

  // 启动真实的 Express 服务器
  async start(): Promise<Server>;

  // 智能降级渲染
  async renderWithFallback(
    url: string,
    context: RenderContext
  ): Promise<RenderResult>;
}
```

**Express 服务器集成**：

- 完整的中间件栈（压缩、安全头、静态文件服务）
- 健康检查端点（`/health`）
- 统计信息端点（`/ssr-stats`, `/cache-stats`）
- 缓存管理端点（`/cache/clear`）
- 主要的 SSR 路由处理器

### 3.2 智能降级链设计

**ISR 模式降级链**：

```
ISR缓存 → ISR重新生成 → SSR服务端渲染 → CSR客户端降级
```

**SSG 模式降级链**：

```
静态文件 → CSR客户端降级
```

**实现机制**：

```typescript
async renderWithFallback(url: string, context: RenderContext): Promise<RenderResult> {
  const fallbackChain = this.renderMode.getFallbackChain(url);

  for (const strategy of fallbackChain) {
    try {
      switch (strategy) {
        case 'cached':    return await this.isrModule.serveCached(url, context);
        case 'regenerate': return await this.isrModule.regenerate(url, context);
        case 'server':    return await this.renderServer(url, context);
        case 'client':    return await this.renderCSR(url, context);
        case 'static':    return await this.renderStatic(url, context);
      }
    } catch (error) {
      // 记录错误，继续下一个策略
      this.logger.warn(`Strategy ${strategy} failed, trying next`);
    }
  }
}
```

### 3.3 ISRModule - 增量静态再生

**核心功能**：

- 缓存管理：检查和提供缓存的页面
- 后台重新生成：在提供缓存页面的同时，后台更新内容
- 重新验证逻辑：基于时间和配置的智能重新验证

**关键实现**：

```typescript
export class ISRModule {
  // 提供缓存的页面
  async serveCached(url: string, context: RenderContext): Promise<RenderResult>;

  // 重新生成页面
  async regenerate(url: string, context: RenderContext): Promise<RenderResult>;

  // 后台重新验证调度
  scheduleBackgroundRevalidation(url: string, context: RenderContext): void;

  // 判断是否需要重新验证
  shouldRevalidate(url: string, metadata: Record<string, any>): boolean;
}
```

**缓存文件结构**：

```
project-root/
└── .isr-cache/
    ├── index.html           # / 路由的缓存
    ├── index.meta.json      # 元数据信息
    ├── about.html           # /about 路由的缓存
    └── about.meta.json
```

### 3.4 CacheManager - 多策略缓存

**支持的缓存策略**：

- **Memory**: 内存缓存（开发环境，快速访问）
- **FileSystem**: 文件系统缓存（持久化，重启保留）
- **Redis**: Redis 缓存（生产环境，分布式）

**关键特性**：

- LRU 淘汰策略
- 自动过期清理
- 缓存统计和监控
- 动态策略切换

### 3.5 Vite 集成架构

**开发模式集成**：

```typescript
// 初始化 Vite 开发服务器
private async initializeViteServer(): Promise<void> {
  this.viteServer = await createViteServer({
    root: projectRoot,
    server: { middlewareMode: true, hmr: true },
    appType: 'custom',
    ssr: { noExternal: ['@novel-isr/engine'] }
  });
}

// 集成到 Express 中间件栈
private async setupMiddleware(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && this.viteServer) {
    this.expressApp.use(this.viteServer.middlewares);
  }
}
```

**生产构建**：

```typescript
public async buildWithVite(): Promise<void> {
  // 构建客户端
  await viteBuild({
    build: { outDir: 'dist/client', ssrManifest: true }
  });

  // 构建服务端
  await viteBuild({
    build: { ssr: true, outDir: 'dist/server' }
  });
}
```

## 4. 配置系统设计

### 4.1 配置层次结构

```typescript
interface NovelSSRConfig {
  mode?: 'isr' | 'ssg'; // 主要渲染模式
  routes?: Record<string, RenderModeType>; // 路由级别配置
  server?: ServerConfig; // 服务器配置
  isr?: ISRConfig; // ISR 特定配置
  cache?: CacheConfig; // 缓存配置
  seo?: SEOConfig; // SEO 配置
  dev?: DevConfig; // 开发配置
  paths?: PathsConfig; // 路径配置
  errorHandling?: ErrorHandlingConfig; // 错误处理配置
}
```

### 4.2 零配置默认值

```typescript
const defaultConfig = {
  mode: 'isr',
  routes: {
    '/': 'ssg', // 首页静态生成
    '/about': 'ssg', // 关于页面静态生成
    '/*': 'isr', // 其他页面 ISR
  },
  isr: {
    revalidate: 3600, // 1小时重新验证
    backgroundRevalidation: true, // 后台重新生成
  },
  cache: { strategy: 'memory', ttl: 3600 },
  seo: { enabled: true, generateSitemap: true, generateRobots: true },
};
```

## 5. 监控和调试系统

### 5.1 内置监控端点

- **`GET /health`**: 健康检查，返回系统状态
- **`GET /ssr-stats`**: 渲染统计信息
- **`GET /cache-stats`**: 缓存统计信息
- **`POST /cache/clear`**: 清理缓存

### 5.2 统计信息收集

```typescript
private stats = {
  requests: 0,      // 总请求数
  ssrSuccess: 0,    // SSR 成功数
  ssrErrors: 0,     // SSR 错误数
  cacheHits: 0,     // 缓存命中数
  fallbacks: 0      // 降级次数
};
```

### 5.3 日志系统

```typescript
export class Logger {
  error(...args: any[]); // 错误日志
  warn(...args: any[]); // 警告日志
  info(...args: any[]); // 信息日志
  debug(...args: any[]); // 调试日志（verbose模式）
}
```

## 6. SEO 优化系统

### 6.1 SEOModule 功能

- **robots.txt 生成**：自动生成搜索引擎爬虫规则
- **sitemap.xml 生成**：基于路由配置生成站点地图
- **SpiderEngine 集成**：智能爬虫发现页面

### 6.2 SpiderEngine 设计

```typescript
export class SpiderEngine {
  // 爬取网站，发现所有页面
  async crawl(startUrl: string): Promise<CrawlResults>;

  // 提取页面 SEO 数据
  extractSEOData(html: string, url: string): SEOData;

  // 遵守 robots.txt 规则
  async loadRobotsTxt(origin: string): Promise<RobotsRules>;
}
```

## 7. 部署架构

### 7.1 容器化部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx novel-isr build
EXPOSE 3000
CMD ["npx", "novel-isr", "start"]
```

### 7.2 负载均衡支持

- **无状态设计**：支持水平扩展
- **会话粘性**：不依赖服务器状态
- **健康检查**：内置健康检查端点

## 8. 性能优化策略

### 8.1 缓存优化

- **多层缓存**：L1内存 → L2文件 → L3Redis
- **智能失效**：基于时间和版本的缓存失效
- **预热机制**：关键页面预生成和预缓存

### 8.2 并发优化

```typescript
// ISR 后台重新验证
scheduleBackgroundRevalidation(url, context) {
  setImmediate(async () => {
    await this.regenerate(url, context);
  });
}

// SSG 并行生成
const results = await Promise.allSettled(
  routes.map(route => this.generatePage(route))
);
```

### 8.3 构建优化

- **Tree Shaking**：Vite 自动移除未使用代码
- **代码分割**：按路由自动分割代码
- **资源优化**：自动处理图片、字体等静态资源
- **压缩优化**：生产构建自动启用 gzip/brotli

## 9. 安全考虑

### 9.1 安全头设置

```typescript
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Powered-By', 'Novel-ISR-Engine');
  next();
});
```

### 9.2 输入验证

- URL 路径验证和清理
- 请求参数验证
- 文件路径安全检查

## 10. 扩展性设计

### 10.1 插件系统（未来规划）

```typescript
interface Plugin {
  name: string;
  install(engine: SSREngine): void;
}

// 使用方式
engine.use(new CachePlugin());
engine.use(new SEOPlugin());
```

### 10.2 中间件支持

```typescript
// Express 中间件集成
app.use('*', ssrMiddleware(engine));

// 自定义渲染钩子
engine.beforeRender((url, context) => {
  // 预处理逻辑
});
```

## 11. 总结

Novel ISR 引擎通过模块化设计实现了四种渲染模式的有机结合：

1. **ISR** - 平衡性能与灵活性的主推方案
2. **SSG** - 追求极致性能的预生成方案
3. **SSR** - 处理动态内容的实时渲染方案
4. **CSR** - 确保可用性的最终降级方案

整个系统通过智能降级链确保了高可用性，通过 Express + Vite 集成提供了优秀的开发体验，通过多层缓存保证了生产性能。这种设计既满足了企业级应用的性能要求，又保持了开发的简单性和灵活性。

**核心优势**：

- ✅ **生产就绪**：完整的 Express 服务器实现，非模拟代码
- ✅ **企业级**：完整的监控、日志、缓存、SEO 系统
- ✅ **高性能**：智能缓存策略和并发优化
- ✅ **开发友好**：零配置启动，热模块替换，完整工具链
- ✅ **高可用**：自动降级链确保服务永远可用
- ✅ **可扩展**：模块化设计，支持水平扩展
