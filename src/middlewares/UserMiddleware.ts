/**
 * Route Middleware 用户定义模块
 *
 * 允许用户在项目根目录定义 middleware.ts，框架自动加载和执行
 *
 * 功能：
 * 1. 自动发现用户的 middleware.ts
 * 2. 路由匹配（支持 matcher 配置）
 * 3. 中间件执行链
 * 4. 重定向、重写、响应修改
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger/Logger';

const logger = Logger.getInstance();

// ============================================================
// 类型定义
// ============================================================

/**
 * 中间件请求对象
 */
export interface MiddlewareRequest {
  /** 请求 URL */
  url: string;
  /** 解析后的 URL 对象 */
  nextUrl: {
    pathname: string;
    search: string;
    searchParams: URLSearchParams;
    href: string;
    origin: string;
    protocol: string;
    host: string;
    hostname: string;
    port: string;
    basePath: string;
    locale?: string;
  };
  /** HTTP 方法 */
  method: string;
  /** 请求头 */
  headers: Map<string, string>;
  /** Cookies */
  cookies: {
    get(name: string): { name: string; value: string } | undefined;
    getAll(): Array<{ name: string; value: string }>;
    has(name: string): boolean;
    set(name: string, value: string): void;
    delete(name: string): void;
  };
  /** IP 地址 */
  ip?: string;
  /** 地理位置 */
  geo?: {
    city?: string;
    country?: string;
    region?: string;
  };
}

/**
 * 中间件 headers 操作接口
 */
interface MiddlewareHeadersAPI {
  set: (name: string, value: string) => MiddlewareResponse;
  get: (name: string) => string | undefined;
  delete: (name: string) => MiddlewareResponse;
}

/**
 * 中间件 cookies 操作接口
 */
interface MiddlewareCookiesAPI {
  set: (name: string, value: string, options?: CookieOptions) => MiddlewareResponse;
  delete: (name: string) => MiddlewareResponse;
}

/**
 * 中间件响应对象
 */
export class MiddlewareResponse {
  private _status: number = 200;
  private _headers: Map<string, string> = new Map();
  private _cookies: Array<{ name: string; value: string; options?: CookieOptions }> = [];
  private _body: string | null = null;
  private _redirect: string | null = null;
  private _rewrite: string | null = null;

  /** 设置响应头 */
  headers: MiddlewareHeadersAPI = {
    set: (name: string, value: string) => {
      this._headers.set(name, value);
      return this;
    },
    get: (name: string) => this._headers.get(name),
    delete: (name: string) => {
      this._headers.delete(name);
      return this;
    },
  };

  /** 设置 Cookie */
  cookies: MiddlewareCookiesAPI = {
    set: (name: string, value: string, options?: CookieOptions) => {
      this._cookies.push({ name, value, options });
      return this;
    },
    delete: (name: string) => {
      this._cookies.push({ name, value: '', options: { maxAge: 0 } });
      return this;
    },
  };

  /** 创建重定向响应 */
  static redirect(url: string, status: 307 | 308 = 307): MiddlewareResponse {
    const response = new MiddlewareResponse();
    response._redirect = url;
    response._status = status;
    return response;
  }

  /** 创建重写响应 */
  static rewrite(url: string): MiddlewareResponse {
    const response = new MiddlewareResponse();
    response._rewrite = url;
    return response;
  }

  /** 创建继续响应（不做任何修改） */
  static next(options?: { request?: { headers?: Record<string, string> } }): MiddlewareResponse {
    const response = new MiddlewareResponse();
    if (options?.request?.headers) {
      for (const [key, value] of Object.entries(options.request.headers)) {
        response._headers.set(`x-middleware-request-${key}`, value);
      }
    }
    return response;
  }

  /** 创建 JSON 响应 */
  static json(data: unknown, options?: { status?: number }): MiddlewareResponse {
    const response = new MiddlewareResponse();
    response._body = JSON.stringify(data);
    response._status = options?.status || 200;
    response._headers.set('Content-Type', 'application/json');
    return response;
  }

  /** 获取内部状态 */
  get _internal() {
    return {
      status: this._status,
      headers: this._headers,
      cookies: this._cookies,
      body: this._body,
      redirect: this._redirect,
      rewrite: this._rewrite,
    };
  }
}

/**
 * Cookie 选项
 */
export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}

/**
 * 中间件配置
 */
export interface MiddlewareConfig {
  /** 路由匹配器 */
  matcher?: string | string[];
}

/**
 * 中间件函数类型
 */
export type MiddlewareFunction = (
  request: MiddlewareRequest
) => MiddlewareResponse | Promise<MiddlewareResponse> | void | Promise<void>;

/**
 * 用户中间件模块
 */
export interface UserMiddlewareModule {
  middleware: MiddlewareFunction;
  config?: MiddlewareConfig;
}

// ============================================================
// 路由匹配
// ============================================================

/**
 * 将 matcher 模式转换为正则表达式
 */
export function matcherToRegex(pattern: string): RegExp {
  // 处理特殊模式
  const regexPattern = pattern
    // 转义正则特殊字符（除了我们需要处理的）
    .replace(/[.+^${}|()\\]/g, '\\$&')
    // :path* -> 匹配任意路径
    .replace(/:path\*/g, '.*')
    // :path -> 匹配单个路径段
    .replace(/:path/g, '[^/]+')
    // [param] -> 匹配单个路径段
    .replace(/\[([^\]]+)\]/g, '[^/]+')
    // /* -> 匹配任意路径
    .replace(/\/\*/g, '/.*');

  return new RegExp(`^${regexPattern}$`);
}

/**
 * 检查路径是否匹配 matcher
 */
export function matchPath(pathname: string, matchers: string | string[]): boolean {
  const patterns = Array.isArray(matchers) ? matchers : [matchers];

  for (const pattern of patterns) {
    // 处理否定模式
    if (pattern.startsWith('!')) {
      const regex = matcherToRegex(pattern.slice(1));
      if (regex.test(pathname)) {
        return false;
      }
      continue;
    }

    const regex = matcherToRegex(pattern);
    if (regex.test(pathname)) {
      return true;
    }
  }

  // 如果只有否定模式，默认匹配所有
  if (patterns.every(p => p.startsWith('!'))) {
    return true;
  }

  return false;
}

/**
 * 默认排除的路径
 */
const DEFAULT_EXCLUDED_PATHS = [
  '/_next',
  '/api',
  '/static',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
];

/**
 * 检查路径是否应该被中间件处理
 */
export function shouldProcessPath(pathname: string, config?: MiddlewareConfig): boolean {
  // 排除静态资源
  for (const excluded of DEFAULT_EXCLUDED_PATHS) {
    if (pathname.startsWith(excluded)) {
      return false;
    }
  }

  // 排除文件扩展名
  if (/\.\w+$/.test(pathname) && !pathname.endsWith('.html')) {
    return false;
  }

  // 如果有 matcher 配置，使用它
  if (config?.matcher) {
    return matchPath(pathname, config.matcher);
  }

  // 默认处理所有路径
  return true;
}

// ============================================================
// 中间件加载和执行
// ============================================================

/**
 * 用户中间件管理器
 */
export class UserMiddlewareManager {
  private middleware: MiddlewareFunction | null = null;
  private config: MiddlewareConfig | null = null;
  private loaded: boolean = false;
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  /**
   * 发现并加载用户中间件
   */
  async load(): Promise<boolean> {
    if (this.loaded) {
      return this.middleware !== null;
    }

    const possiblePaths = [
      path.join(this.projectRoot, 'middleware.ts'),
      path.join(this.projectRoot, 'middleware.js'),
      path.join(this.projectRoot, 'src', 'middleware.ts'),
      path.join(this.projectRoot, 'src', 'middleware.js'),
    ];

    for (const middlewarePath of possiblePaths) {
      if (fs.existsSync(middlewarePath)) {
        try {
          const module = (await import(middlewarePath)) as UserMiddlewareModule;

          if (typeof module.middleware === 'function') {
            this.middleware = module.middleware;
            this.config = module.config || null;
            this.loaded = true;
            logger.info(`✅ 已加载用户中间件: ${middlewarePath}`);
            return true;
          }
        } catch (error) {
          logger.error(`❌ 加载中间件失败 ${middlewarePath}:`, error);
        }
      }
    }

    this.loaded = true;
    return false;
  }

  /**
   * 执行中间件
   */
  async execute(request: MiddlewareRequest): Promise<MiddlewareResponse | null> {
    if (!this.middleware) {
      return null;
    }

    // 检查路径是否应该被处理
    if (!shouldProcessPath(request.nextUrl.pathname, this.config || undefined)) {
      return null;
    }

    try {
      const result = await this.middleware(request);
      return result || null;
    } catch (error) {
      logger.error('中间件执行错误:', error);
      return null;
    }
  }

  /**
   * 检查是否有中间件
   */
  hasMiddleware(): boolean {
    return this.middleware !== null;
  }

  /**
   * 获取匹配配置
   */
  getConfig(): MiddlewareConfig | null {
    return this.config;
  }
}

// ============================================================
// Express 集成
// ============================================================

type ExpressRequest = {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  ip?: string;
  originalUrl?: string;
  path?: string;
  query?: Record<string, string>;
};

type ExpressResponse = {
  status: (code: number) => ExpressResponse;
  setHeader: (name: string, value: string) => ExpressResponse;
  redirect: (status: number, url: string) => void;
  json: (data: unknown) => void;
  send: (body: string) => void;
  cookie: (name: string, value: string, options?: object) => void;
  clearCookie: (name: string) => void;
};

type ExpressNext = (err?: unknown) => void;

/**
 * 将 Express 请求转换为中间件请求
 */
function toMiddlewareRequest(req: ExpressRequest): MiddlewareRequest {
  const raw = req.originalUrl || req.url;
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : undefined;

  let url: URL | null = null;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else if (hostHeader) {
    url = new URL(raw, `http://${hostHeader}`);
  }

  const pathname = url ? url.pathname : raw.split('?')[0] || '/';
  const search = url
    ? url.search
    : raw.includes('?')
      ? `?${raw.split('?').slice(1).join('?')}`
      : '';
  const searchParams = url
    ? url.searchParams
    : new URLSearchParams(search.startsWith('?') ? search.slice(1) : '');
  const href = url ? url.href : raw;
  const origin = url ? url.origin : '';
  const protocol = url ? url.protocol : '';
  const host = url ? url.host : '';
  const hostname = url ? url.hostname : '';
  const port = url ? url.port : '';

  const cookies = new Map<string, string>();
  if (req.cookies) {
    for (const [key, value] of Object.entries(req.cookies)) {
      cookies.set(key, value);
    }
  }

  return {
    url: req.url,
    nextUrl: {
      pathname,
      search,
      searchParams,
      href,
      origin,
      protocol,
      host,
      hostname,
      port,
      basePath: '',
    },
    method: req.method,
    headers: new Map(
      Object.entries(req.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
    cookies: {
      get: name => {
        const value = cookies.get(name);
        return value ? { name, value } : undefined;
      },
      getAll: () => Array.from(cookies.entries()).map(([name, value]) => ({ name, value })),
      has: name => cookies.has(name),
      set: (name, value) => cookies.set(name, value),
      delete: name => cookies.delete(name),
    },
    ip: req.ip,
  };
}

/**
 * 应用中间件响应到 Express 响应
 */
function applyMiddlewareResponse(
  response: MiddlewareResponse,
  res: ExpressResponse,
  next: ExpressNext
): void {
  const internal = response._internal;

  // 设置 cookies
  for (const cookie of internal.cookies) {
    if (cookie.options?.maxAge === 0) {
      res.clearCookie(cookie.name);
    } else {
      res.cookie(cookie.name, cookie.value, cookie.options);
    }
  }

  // 设置响应头
  for (const [key, value] of internal.headers) {
    res.setHeader(key, value);
  }

  // 处理重定向
  if (internal.redirect) {
    res.redirect(internal.status, internal.redirect);
    return;
  }

  // 处理重写（修改请求 URL 后继续）
  if (internal.rewrite) {
    // 这里需要修改请求的 URL，然后继续处理
    // 在 Express 中，我们通过修改 req.url 实现
    next();
    return;
  }

  // 处理直接响应
  if (internal.body !== null) {
    res.status(internal.status).send(internal.body);
    return;
  }

  // 继续处理
  next();
}

/**
 * 创建 Express 中间件
 */
export function createUserMiddleware(projectRoot?: string) {
  const manager = new UserMiddlewareManager(projectRoot);
  let loadPromise: Promise<boolean> | null = null;

  return async (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => {
    // 延迟加载
    if (!loadPromise) {
      loadPromise = manager.load();
    }
    await loadPromise;

    // 如果没有用户中间件，直接继续
    if (!manager.hasMiddleware()) {
      return next();
    }

    // 转换请求并执行
    const middlewareRequest = toMiddlewareRequest(req);
    const response = await manager.execute(middlewareRequest);

    // 如果没有响应，继续处理
    if (!response) {
      return next();
    }

    // 应用响应
    applyMiddlewareResponse(response, res, next);
  };
}

// ============================================================
// 全局实例
// ============================================================

let globalManager: UserMiddlewareManager | null = null;

/**
 * 获取全局中间件管理器
 */
export function getUserMiddlewareManager(projectRoot?: string): UserMiddlewareManager {
  if (!globalManager) {
    globalManager = new UserMiddlewareManager(projectRoot);
  }
  return globalManager;
}

/**
 * 重置全局中间件管理器（用于测试）
 */
export function resetUserMiddlewareManager(): void {
  globalManager = null;
}
