# Novel ISR Engine - API 文档

## 目录

- [核心 API](#核心-api)
- [企业级引擎](#企业级引擎)
- [React Server Components](#react-server-components)
- [缓存系统](#缓存系统)
- [SEO 引擎](#seo-引擎)
- [降级链引擎](#降级链引擎)
- [AppShell 管理器](#appshell-管理器)
- [Vite 插件](#vite-插件)

## 核心 API

### createEnterpriseApp

创建企业级应用实例的快捷函数。

```typescript
function createEnterpriseApp(options?: {
  config?: any;
  mode?: 'development' | 'production';
  features?: {
    rsc?: boolean;
    multiCache?: boolean;
    advancedSEO?: boolean;
    monitoring?: boolean;
    appShell?: boolean;
  };
}): Promise<EnterpriseApp>
```

**参数：**

- `options.config` - 自定义配置对象
- `options.mode` - 运行模式，默认根据 NODE_ENV 判断
- `options.features` - 启用的企业级功能

**返回值：**

```typescript
interface EnterpriseApp {
  engine: EnterpriseISREngine;
  config: any;
  start(port?: number): Promise<void>;
  render(url: string, context?: any): Promise<RenderResult>;
  getStats(): any;
  shutdown(): Promise<void>;
}
```

**示例：**

```typescript
import { createEnterpriseApp } from 'isr-engine';

const app = await createEnterpriseApp({
  mode: 'production',
  features: {
    rsc: true,
    multiCache: true,
    advancedSEO: true
  }
});

await app.start(3000);
```

### createISRApp

创建传统 ISR 应用实例的兼容函数。

```typescript
function createISRApp(config?: any): Promise<ISRApp>
```

## 企业级引擎

### EnterpriseISREngine

企业级 ISR 引擎主类。

```typescript
class EnterpriseISREngine {
  constructor(config: EnterpriseConfig)
  
  async start(): Promise<void>
  async render(url: string, context?: RenderContext): Promise<RenderResult>
  async shutdown(): Promise<void>
  
  getStats(): EngineStats
  getHealth(): HealthStatus
}
```

#### 配置接口

```typescript
interface EnterpriseConfig {
  mode: 'isr' | 'ssr' | 'ssg' | 'csr';
  dev?: {
    port?: number;
    host?: string;
    verbose?: boolean;
    hmr?: boolean;
  };
  enterprise?: {
    enabled: boolean;
    fallbackChain?: FallbackChainConfig;
    cache?: CacheConfig;
    seo?: SEOConfig;
    monitoring?: MonitoringConfig;
  };
  rsc?: RSCConfig;
  appShell?: AppShellConfig;
}
```

#### 渲染上下文

```typescript
interface RenderContext {
  url: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  userAgent?: string;
  locale?: string;
  theme?: string;
  experimental?: Record<string, any>;
}
```

#### 渲染结果

```typescript
interface RenderResult {
  html: string;
  css?: string;
  js?: string;
  meta?: MetaData;
  headers?: Record<string, string>;
  statusCode: number;
  renderTime: number;
  strategy: string;
  cached: boolean;
  error?: Error;
}
```

## React Server Components

### EnterpriseRSCRuntime

企业级 RSC 运行时。

```typescript
class EnterpriseRSCRuntime {
  constructor(config: RSCRuntimeConfig)
  
  async renderRSC(
    url: string, 
    context: RenderContext, 
    appTreeFactory: () => React.ReactElement
  ): Promise<RSCRenderResult>
  
  async renderComponent(
    componentPath: string, 
    props: any
  ): Promise<string>
  
  invalidateComponent(componentPath: string): void
  getComponentCache(): ComponentCacheStats
}
```

#### RSC 配置

```typescript
interface RSCRuntimeConfig {
  enabled: boolean;
  maxWorkers: number;
  cacheSize: number;
  componentsDir: string;
  vmConfig?: {
    timeout: number;
    memoryLimit: string;
    sandbox: boolean;
  };
}
```

#### RSC 渲染结果

```typescript
interface RSCRenderResult {
  tree: React.ReactElement;
  payload: string;
  metadata: {
    components: string[];
    renderTime: number;
    cached: boolean;
  };
}
```

## 缓存系统

### EnterpriseCacheEngine

多层企业级缓存引擎。

```typescript
class EnterpriseCacheEngine {
  constructor(config: CacheEngineConfig)
  
  async get(key: string, tags?: string[]): Promise<any>
  async set(key: string, value: any, options?: CacheOptions): Promise<void>
  async delete(key: string): Promise<boolean>
  async invalidateByTags(tags: string[]): Promise<number>
  async clear(layer?: CacheLayer): Promise<void>
  
  getStats(): CacheStats
  getHealth(): CacheHealth
}
```

#### 缓存配置

```typescript
interface CacheEngineConfig {
  multiLayer: boolean;
  compression: boolean;
  encryption: boolean;
  analytics: boolean;
  
  l1?: {
    maxSize: number;
    ttl: number;
    algorithm: 'lru' | 'lfu';
  };
  
  l2?: {
    host: string;
    port: number;
    password?: string;
    ttl: number;
  };
  
  l3?: {
    directory: string;
    maxSize: string;
    ttl: number;
  };
}
```

#### 缓存选项

```typescript
interface CacheOptions {
  ttl?: number;
  tags?: string[];
  compress?: boolean;
  encrypt?: boolean;
  priority?: 'low' | 'normal' | 'high';
}
```

#### 缓存统计

```typescript
interface CacheStats {
  l1: {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  l2: LayerStats;
  l3: LayerStats;
  total: {
    requests: number;
    hitRate: number;
    avgResponseTime: number;
  };
}
```

## SEO 引擎

### EnterpriseSEOEngine

高级 SEO 优化引擎。

```typescript
class EnterpriseSEOEngine {
  constructor(config: SEOEngineConfig)
  
  async optimizePage(
    url: string, 
    context: RenderContext, 
    result: RenderResult
  ): Promise<RenderResult>
  
  generateMetaTags(pageData: PageData): MetaTag[]
  generateStructuredData(pageData: PageData): StructuredData
  generateSitemap(routes: Route[]): string
  
  analyzePage(html: string): SEOAnalysis
}
```

#### SEO 配置

```typescript
interface SEOEngineConfig {
  advanced: boolean;
  structuredData: boolean;
  performance: boolean;
  multiLanguage: boolean;
  
  defaults?: {
    title?: string;
    description?: string;
    keywords?: string[];
    author?: string;
    openGraph?: OpenGraphConfig;
    twitter?: TwitterConfig;
  };
  
  templates?: Record<string, SEOTemplate>;
}
```

#### 页面数据

```typescript
interface PageData {
  url: string;
  title?: string;
  description?: string;
  keywords?: string[];
  image?: string;
  publishDate?: Date;
  modifiedDate?: Date;
  author?: string;
  category?: string;
  tags?: string[];
  data?: Record<string, any>;
}
```

#### SEO 分析结果

```typescript
interface SEOAnalysis {
  score: number;
  issues: SEOIssue[];
  suggestions: SEOSuggestion[];
  metrics: {
    titleLength: number;
    descriptionLength: number;
    headingStructure: HeadingAnalysis;
    imageOptimization: ImageAnalysis;
    performance: PerformanceAnalysis;
  };
}
```

## 降级链引擎

### FallbackChainEngine

智能降级链引擎。

```typescript
class FallbackChainEngine {
  constructor(config: FallbackChainConfig)
  
  async executeChain(url: string, context?: RenderContext): Promise<RenderResult>
  
  addStrategy(strategy: FallbackStrategy): void
  removeStrategy(name: string): boolean
  updateStrategy(name: string, updates: Partial<FallbackStrategy>): boolean
  
  getStrategyStats(): StrategyStats[]
  optimizeStrategies(): void
}
```

#### 降级策略

```typescript
interface FallbackStrategy {
  name: string;
  priority: number;
  timeout: number;
  retries: number;
  healthCheck?: () => Promise<boolean>;
  execute: (url: string, context: RenderContext) => Promise<RenderResult>;
}
```

#### 降级链配置

```typescript
interface FallbackChainConfig {
  enabled: boolean;
  strategies: FallbackStrategyConfig[];
  adaptive?: {
    enabled: boolean;
    learningRate: number;
    performanceThreshold: number;
  };
  circuit?: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
  };
}
```

## AppShell 管理器

### AppShellManager

应用外壳管理器。

```typescript
class AppShellManager {
  constructor(projectRoot: string, config: AppShellConfig)
  
  async getEntry(entryId: string): Promise<AppShellEntry | null>
  async renderShell(entryId: string, context: RenderContext): Promise<string>
  
  registerEntry(entryId: string, entry: AppShellEntry): void
  unregisterEntry(entryId: string): boolean
  
  preloadResources(entryId: string): Promise<void>
  getStats(): AppShellStats
}
```

#### AppShell 配置

```typescript
interface AppShellConfig {
  enabled: boolean;
  template: string;
  entries: Record<string, string>;
  preloadResources: string[];
  caching?: {
    enabled: boolean;
    ttl: number;
  };
}
```

#### AppShell 条目

```typescript
interface AppShellEntry {
  id: string;
  path: string;
  component: React.ComponentType;
  preloadResources?: string[];
  meta?: {
    title?: string;
    description?: string;
    theme?: string;
  };
}
```

## Vite 插件

### createEnterpriseViteISRPlugin

创建企业级 Vite ISR 插件。

```typescript
function createEnterpriseViteISRPlugin(
  options: ViteISRPluginOptions
): Plugin[]
```

#### 插件选项

```typescript
interface ViteISRPluginOptions {
  rsc?: {
    enabled: boolean;
    componentsDir: string;
    manifest?: boolean;
  };
  
  appShell?: {
    enabled: boolean;
    entries: Record<string, string>;
  };
  
  enterprise?: {
    fallbackChain: boolean;
    multiLayerCache: boolean;
    advancedSEO: boolean;
  };
  
  build?: {
    sourcemap: boolean;
    minify: boolean;
    splitting: boolean;
  };
}
```

### createEnterpriseViteDevMiddleware

创建企业级 Vite 开发中间件。

```typescript
function createEnterpriseViteDevMiddleware(
  server: ViteDevServer,
  options: DevMiddlewareOptions
): Connect.NextHandleFunction
```

## 错误处理

### ErrorHandler

统一错误处理器。

```typescript
class ErrorHandler {
  static handle(error: Error, context?: ErrorContext): void
  static createError(code: string, message: string, details?: any): NovelISRError
}
```

#### 错误类型

```typescript
class NovelISRError extends Error {
  code: string;
  details?: any;
  timestamp: Date;
  context?: ErrorContext;
}
```

## 日志系统

### Logger

企业级日志记录器。

```typescript
class Logger {
  static info(message: string, meta?: any): void
  static warn(message: string, meta?: any): void
  static error(message: string, error?: Error, meta?: any): void
  static debug(message: string, meta?: any): void
  
  static createChild(namespace: string): Logger
}
```

## 指标收集

### MetricsCollector

性能指标收集器。

```typescript
class MetricsCollector {
  static record(metric: string, value: number, tags?: Record<string, string>): void
  static increment(metric: string, tags?: Record<string, string>): void
  static histogram(metric: string, value: number, tags?: Record<string, string>): void
  static gauge(metric: string, value: number, tags?: Record<string, string>): void
  
  static getMetrics(): Metrics
  static export(format: 'json' | 'prometheus'): string
}
```

## 类型定义

完整的 TypeScript 类型定义请参考：

- `types/index.ts` - 核心类型
- `types/engine.ts` - 引擎相关类型
- `types/cache.ts` - 缓存相关类型
- `types/rsc.ts` - RSC 相关类型
- `types/seo.ts` - SEO 相关类型