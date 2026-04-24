/**
 * ISR 引擎类型定义
 *
 */

/**
 * 渲染模式（用户级）—— 路由可选的**三种真实**缓存策略
 *
 *   isr  ── 运行时入缓存 + TTL；过期后 SWR 回放旧 + 后台重渲
 *   ssr  ── 不入缓存；每次请求都跑 RSC + SSR 管线
 *   ssg  ── 构建期 spider 预生成磁盘 HTML；运行时 express.static 直发
 *
 * **csr 不在用户级**——因为"绕过 RSC 跑纯客户端"在 plugin-rsc 模型下不是一个
 * 选择性的渲染策略，而是 server 跑不动时的**降级兜底**。详见下方 InternalStrategyType。
 */
export type RenderModeType = 'ssg' | 'isr' | 'ssr';

/**
 * 内部降级策略（fallback chain 的元素，不向用户暴露选择）
 *
 *   static       ── 直接 serve 构建期物化的 dist/client/<path>/index.html
 *   cached       ── 命中 ISR LRU 内存缓存
 *   regenerate   ── 缓存过期 / 不存在时重新跑管线，结果入缓存
 *   server       ── 实时跑 RSC + SSR 管线（不入缓存，等价 SSR）
 *   csr-shell    ── server 自身崩溃时的最后兜底：返回最小壳 HTML（无 Flight，
 *                   带 self.__NO_HYDRATE=1），浏览器走 createRoot 从零渲染并
 *                   通过 _.rsc 端点尝试自救拉数据 —— 体验降级但不是 5xx 白屏
 */
export type InternalStrategyType = 'static' | 'cached' | 'regenerate' | 'server' | 'csr-shell';
export type CacheStrategyType = 'no-cache' | 'memory' | 'redis' | 'filesystem';

/**
 * 路由级规则（对象形式）—— 允许精细控制 TTL 与 stale-while-revalidate 窗口
 */
export interface RouteRuleObject {
  mode: RenderModeType;
  /** TTL（秒），覆盖全局 isr.revalidate 默认值 */
  ttl?: number;
  /** stale-while-revalidate 窗口（秒）—— TTL 过期后继续回放旧内容的时长 */
  staleWhileRevalidate?: number;
}

/**
 * 路由规则 —— 字符串 shorthand 或完整对象
 *   'isr'                                        等价于 { mode: 'isr', ttl: 默认, swr: 默认 }
 *   { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 }
 */
export type RouteRule = RenderModeType | RouteRuleObject;

export const RenderModes = {
  SSG: 'ssg' as const, // 构建期预生成磁盘文件
  ISR: 'isr' as const, // 运行时缓存 + TTL + SWR
  SSR: 'ssr' as const, // 不缓存，每次实时跑管线
} as const;

// 内部渲染策略 (不向用户暴露)
export const InternalStrategies = {
  STATIC: 'static' as const, // 服务预构建文件（SSG）
  CACHED: 'cached' as const, // 从 ISR 缓存服务
  REGENERATE: 'regenerate' as const, // ISR 重新生成
  SERVER: 'server' as const, // 实时跑管线（SSR / 中间兜底）
  CSR_SHELL: 'csr-shell' as const, // 最后兜底：返回壳 HTML，浏览器自救
} as const;

// 缓存策略
export const CacheStrategies = {
  NO_CACHE: 'no-cache' as const,
  MEMORY: 'memory' as const,
  REDIS: 'redis' as const,
  FILE_SYSTEM: 'filesystem' as const,
} as const;

/**
 * 自动降级链 —— 路由 mode 决定优先尝试哪些策略，失败逐级往下
 * 所有链路最末端都是 'csr-shell'，保证 server 完全崩溃时浏览器仍能拿到壳 HTML
 *
 * 例：mode=isr 的请求处理顺序
 *   1. cached     ── 命中 LRU → 直接回放
 *   2. regenerate ── miss / stale → 跑管线 + 入缓存
 *   3. server     ── 缓存层崩溃 → 实时跑管线（不入缓存）
 *   4. csr-shell  ── 管线本身抛异常 → 返回壳 HTML，浏览器接管
 */
export const FallbackChain: Record<RenderModeType, InternalStrategyType[]> = {
  isr: ['cached', 'regenerate', 'server', 'csr-shell'],
  ssg: ['static', 'regenerate', 'server', 'csr-shell'],
  ssr: ['server', 'csr-shell'],
};

// 配置接口定义
// 主配置接口
export interface ISRConfig {
  /** 应用名称（用于 CSR 降级页面标题等，默认 'ISR App'） */
  appName?: string;

  /** 全局默认渲染模式 */
  renderMode: RenderModeType;

  /**
   * 兼容别名：等同于 renderMode
   * 消费端可使用 mode 代替 renderMode
   */
  mode?: RenderModeType;

  /**
   * 路由级别覆盖配置（可选）
   * 仅当需要对特定路由使用不同于全局 renderMode 时才配置
   * 支持通配符匹配：'/posts/*' 匹配所有 /posts/ 开头的路由
   * 支持动态路由：'/post/:id' 匹配 /post/123 等
   *
   * @example
   * ```ts
   * routeOverrides: {
   *   '/': 'ssg',           // 首页使用 SSG
   *   '/admin/*': 'ssr',    // 管理后台使用 SSR
   * }
   * ```
   */
  routeOverrides?: Record<string, RouteRule>;

  /**
   * 兼容别名：等同于 routeOverrides
   * 消费端可使用 routes 代替 routeOverrides
   */
  routes?: Record<string, RouteRule>;

  cache: {
    strategy: CacheStrategyType;
    ttl: number;
  };
  /**
   * SEO 配置 —— 可选；缺省时 engine 启用默认行为：
   *   - enabled = true（dev/prod 都自动注入 sitemap.xml / robots.txt 路由）
   *   - baseUrl 解析顺序：
   *       1) 此处显式 baseUrl
   *       2) 环境变量 SEO_BASE_URL → PUBLIC_BASE_URL → BASE_URL
   *       3) dev 模式：http://localhost:${server.port||3000}
   *       4) prod 模式且仍未拿到：保留空串（生成 sitemap 时报错并提示）
   */
  seo?: {
    enabled?: boolean;
    generateSitemap?: boolean;
    generateRobots?: boolean;
    baseUrl?: string;
  };
  server?: {
    ssl?: {
      key: string;
      cert: string;
    };
    port: number;
    host?: string;
    protocol?: 'http1.1' | 'http2' | 'http3' | 'https';
    /**
     * Node server timeout limits. These protect the origin from slowloris,
     * stuck SSR/RSC requests, and long-lived keep-alive exhaustion. Put CDN /
     * reverse proxy timeouts in front as the first line of defense.
     */
    timeouts?: {
      requestTimeoutMs?: number;
      headersTimeoutMs?: number;
      keepAliveTimeoutMs?: number;
      idleTimeoutMs?: number;
      shutdownTimeoutMs?: number;
      maxRequestsPerSocket?: number;
    };
    /**
     * HTTP/2 origin settings. Production deployments should normally terminate
     * HTTP/2 at CDN / Nginx / ALB and proxy HTTP/1.1 to Node unless this path
     * has been tested with the exact proxy and client matrix.
     */
    http2?: {
      maxConcurrentStreams?: number;
      maxSessionMemory?: number;
      maxHeaderListSize?: number;
    };
    /**
     * HTTP/3 is only advertised when a real QUIC implementation is available.
     * If unavailable, engine falls back to HTTP/2 TLS and does not emit Alt-Svc.
     */
    http3?: {
      enabled?: boolean;
      quicPort?: number;
      altSvcMaxAge?: number;
      enable0RTT?: boolean;
      maxIdleTimeout?: number;
      initialMaxStreamData?: number;
      initialMaxData?: number;
    };
    /**
     * 管理端点（/health /metrics /__isr/*）暴露策略
     *
     * 安全默认值：
     *   - development：health/stats/clear/metrics 全开，便于本地调试
     *   - production：仅 health 默认公开；stats/clear/metrics 默认关闭
     *
     * 生产若显式开启 stats/clear/metrics：
     *   - `public: true` 代表公开暴露，会打印 warning
     *   - `public: false` 时要求同时配置 `authToken`
     */
    admin?: {
      /** 共享管理口令；接受 `Authorization: Bearer <token>` 或自定义 header */
      authToken?: string;
      /** 自定义 header 名，默认 `x-isr-admin-token` */
      tokenHeader?: string;
      health?: {
        enabled?: boolean;
        public?: boolean;
      };
      stats?: {
        enabled?: boolean;
        public?: boolean;
      };
      clear?: {
        enabled?: boolean;
        public?: boolean;
      };
      metrics?: {
        enabled?: boolean;
        public?: boolean;
      };
    };
    /**
     * Node 进程内压缩策略
     *
     * 默认启用 streaming-safe gzip；Brotli 建议放到 CDN / Nginx / Edge 层做，
     * 避免 Node 端为追求 br 而缓冲整包，破坏 SSR/RSC 流式输出。
     */
    compression?: {
      enabled?: boolean;
      threshold?: number;
      level?: number;
    };
  };

  /** 服务端入口配置 */
  entry?: {
    /** 服务端入口文件路径 */
    server?: string;
    /** 客户端入口文件路径（相对于项目根目录） */
    client?: string;
  };

  /** API 基址（Server Component / Action 从此处派生数据源 URL） */
  apiUrl?: string;

  /** 开发选项 */
  dev?: {
    verbose?: boolean;
    hmr?: boolean;
  };

  /**
   * 多租户配置 —— 预留接口（当前 engine 不消费，未来扩展时使用）
   *
   * 未来语义示例：
   *   - `enabled: true` 时，缓存 key 自动叠加 tenantId 前缀
   *   - `resolveTenant(req)` 由用户实现，决定本次请求归属哪个租户
   *   - `revalidateTag` 默认按当前租户隔离，可通过 `{ scope: 'global' }` 跨租户
   */
  tenants?: {
    /** 默认 false；true 时启用多租户缓存隔离 */
    enabled?: boolean;
    /** 解析当前请求的租户 ID（返回 null 表示走默认/匿名租户） */
    resolveTenant?: (req: {
      headers: Record<string, string | string[] | undefined>;
      url: string;
    }) => string | null | Promise<string | null>;
    /** 已知租户白名单（用于 SSG spider 预生成时枚举） */
    knownTenants?: string[];
  };

  /**
   * 沙箱 / VM 配置 —— 预留接口（当前 engine 不消费，未来扩展时使用）
   *
   * 未来语义示例：
   *   - `strategy: 'node-vm'` 用 `node:vm` Context 跑用户提交代码
   *   - `strategy: 'isolate'` 用 isolated-vm 做 V8 isolate 级隔离
   *   - `strategy: 'worker'` 用 Worker 线程隔离
   *
   * 适用场景：CMS 模板、用户插件市场、表达式引擎 —— 任何"不可信代码必须隔离执行"的需求。
   * RSC 自身**不**需要 sandbox（项目代码全可信）。
   */
  sandbox?: {
    enabled?: boolean;
    strategy?: 'none' | 'node-vm' | 'isolate' | 'worker';
    /** 单次执行内存上限（MB） */
    memoryLimitMb?: number;
    /** 单次执行 CPU 时间上限（ms） */
    timeoutMs?: number;
    /** 允许的全局变量白名单 */
    allowedGlobals?: string[];
  };

  /** ISR 相关配置 */
  isr?: {
    /** 默认 TTL（秒）—— 未在 routes 显式声明时使用 */
    revalidate?: number;
    /** 是否启用后台重验证（SWR），默认 true */
    backgroundRevalidation?: boolean;
  };

  /** SSG 预生成配置 */
  ssg?: {
    /** 显式 SSG 路由列表（可选，优先级高于 routes 中 mode=ssg 的条目） */
    routes?: string[] | (() => Promise<string[]>);
    /** 并发度，默认 3 */
    concurrent?: number;
    /** 单页请求超时毫秒，默认 30_000；防 hang 拖死整个 build */
    requestTimeoutMs?: number;
    /** 单页最大重试次数（不含首次），默认 3；只重试 timeout/network/5xx，不重试 4xx */
    maxRetries?: number;
    /** 重试初始退避毫秒，默认 200；指数退避 = base * 2^(N-1) */
    retryBaseDelayMs?: number;
    /**
     * 整体失败率阈值（0-1），默认 0.05（5%）；超过则 build 失败。
     * 设 1.0 关闭（不推荐——会 mask 真实问题）。设 0 = 任何失败都 fail build。
     */
    failBuildThreshold?: number;
  };
}
