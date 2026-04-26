/**
 * 路由发现器
 *
 * ISR-Engine 的路由发现模块，专注于：
 * 1. 从文件路径解析 URL 路由
 * 2. 动态路由参数识别 [id] -> :id
 * 3. Catch-all 路由支持 [...slug] -> *slug
 *
 * 设计原则：
 * - 不强制使用特定的文件约定（如 page.tsx、layout.tsx）
 * - 支持 pages 目录风格和自定义配置
 * - 简单、准确、可预测
 *
 * 不实现的特性（保持简单）：
 * - 路由组 (group) 和平行路由 @slot —— 用 routes.tsx 显式表达更清晰
 */

import path from 'path';
import type { RouteDiscoveryConfig, FileInfo, RouteType } from './types';
import { SUPPORTED_EXTENSIONS } from './types';

// Re-export RouteType for convenience
export type { RouteType };

// ============ 路由类型 ============

/**
 * 动态路由参数信息
 */
export interface DynamicParam {
  /** 参数名称 */
  name: string;
  /** 参数类型 */
  type: 'single' | 'catch-all' | 'optional-catch-all';
  /** 在 URL 中的位置索引 */
  position: number;
}

/**
 * 解析后的路由信息
 */
export interface ParsedRoute {
  /** URL 路径（如 /blog/:id） */
  urlPath: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 路由类型 */
  type: RouteType;
  /** 是否为动态路由 */
  isDynamic: boolean;
  /** 动态参数列表 */
  params: DynamicParam[];
  /** 是否为 catch-all 路由 */
  isCatchAll: boolean;
  /** 原始文件相对路径 */
  relativePath: string;
}

// ============ 正则表达式 ============

/** 动态路由正则：匹配 [param] */
const DYNAMIC_SEGMENT_REGEX = /^\[([^\].]+)\]$/;

/** Catch-all 路由正则：匹配 [...slug] */
const CATCH_ALL_REGEX = /^\[\.\.\.(\w+)\]$/;

/** 可选 Catch-all 路由正则：匹配 [[...slug]] */
const OPTIONAL_CATCH_ALL_REGEX = /^\[\[\.\.\.(\w+)\]\]$/;

// ============ 核心解析函数 ============

/**
 * 从文件路径解析路由
 *
 * 支持的路径格式：
 * - pages/about.tsx -> /about
 * - pages/blog/[id].tsx -> /blog/:id
 * - pages/docs/[...slug].tsx -> /docs/*slug
 * - src/routes/users.tsx -> /users（自定义目录）
 *
 * @param fileInfo - 文件信息
 * @param config - 路由发现配置
 * @returns 解析后的路由信息，无法解析时返回 null
 */
export function parseRouteFromFile(
  fileInfo: FileInfo,
  config: RouteDiscoveryConfig
): ParsedRoute | null {
  const { relativePath, absolutePath } = fileInfo;
  const fileName = path.basename(relativePath);

  // 检查文件扩展名
  if (!isSupportedExtension(fileName)) {
    return null;
  }

  // 策略 1: pages 目录
  if (relativePath.startsWith(`${config.pagesDir}/`)) {
    return parsePagesRoute(relativePath, absolutePath, config.pagesDir);
  }

  // 策略 2: 自定义 routes 目录（如果配置了）
  if (config.routesDir && relativePath.startsWith(`${config.routesDir}/`)) {
    return parseCustomRoute(relativePath, absolutePath, config.routesDir);
  }

  return null;
}

/**
 * 解析 pages 目录风格的路由
 *
 * 规则：
 * - 文件名即路由名
 * - index.tsx 映射到目录路径
 * - _ 开头的文件被忽略
 * - api/ 目录下的文件为 API 路由
 */
function parsePagesRoute(
  relativePath: string,
  absolutePath: string,
  pagesDir: string
): ParsedRoute | null {
  const fileName = path.basename(relativePath);

  // 排除 _ 开头的文件（如 _app.tsx, _document.tsx）
  if (fileName.startsWith('_')) {
    return null;
  }

  // 判断是否为 API 路由
  const isApiRoute = relativePath.includes('/api/');
  const routeType: RouteType = isApiRoute ? 'api' : 'page';

  // 移除 pages/ 前缀和文件扩展名
  let urlPath = relativePath.slice(pagesDir.length + 1).replace(/\.(tsx|jsx|ts|js)$/, '');

  // 处理 index 文件
  if (urlPath.endsWith('/index') || urlPath === 'index') {
    urlPath = urlPath.replace(/\/?index$/, '');
  }

  // 解析动态参数
  const { convertedPath, params, isCatchAll } = parseDynamicSegments(urlPath);

  // 规范化路径
  const normalizedPath = normalizeUrlPath(convertedPath);

  return {
    urlPath: normalizedPath,
    filePath: absolutePath,
    type: routeType,
    isDynamic: params.length > 0,
    params,
    isCatchAll,
    relativePath,
  };
}

/**
 * 解析自定义目录的路由
 */
function parseCustomRoute(
  relativePath: string,
  absolutePath: string,
  routesDir: string
): ParsedRoute | null {
  const fileName = path.basename(relativePath);

  // 排除 _ 开头的文件
  if (fileName.startsWith('_')) {
    return null;
  }

  // 移除目录前缀和文件扩展名
  let urlPath = relativePath.slice(routesDir.length + 1).replace(/\.(tsx|jsx|ts|js)$/, '');

  // 处理 index 文件
  if (urlPath.endsWith('/index') || urlPath === 'index') {
    urlPath = urlPath.replace(/\/?index$/, '');
  }

  // 解析动态参数
  const { convertedPath, params, isCatchAll } = parseDynamicSegments(urlPath);

  // 规范化路径
  const normalizedPath = normalizeUrlPath(convertedPath);

  return {
    urlPath: normalizedPath,
    filePath: absolutePath,
    type: 'page',
    isDynamic: params.length > 0,
    params,
    isCatchAll,
    relativePath,
  };
}

/**
 * 解析路径中的动态段
 *
 * @param urlPath - 原始 URL 路径
 * @returns 转换后的路径、参数列表、是否为 catch-all
 */
function parseDynamicSegments(urlPath: string): {
  convertedPath: string;
  params: DynamicParam[];
  isCatchAll: boolean;
} {
  const segments = urlPath.split('/');
  const params: DynamicParam[] = [];
  let isCatchAll = false;

  const convertedSegments = segments.map((segment, index) => {
    // 可选 catch-all: [[...slug]] -> *slug?
    const optionalCatchAllMatch = segment.match(OPTIONAL_CATCH_ALL_REGEX);
    if (optionalCatchAllMatch) {
      isCatchAll = true;
      params.push({
        name: optionalCatchAllMatch[1],
        type: 'optional-catch-all',
        position: index,
      });
      return `*${optionalCatchAllMatch[1]}?`;
    }

    // Catch-all: [...slug] -> *slug
    const catchAllMatch = segment.match(CATCH_ALL_REGEX);
    if (catchAllMatch) {
      isCatchAll = true;
      params.push({
        name: catchAllMatch[1],
        type: 'catch-all',
        position: index,
      });
      return `*${catchAllMatch[1]}`;
    }

    // 动态参数: [id] -> :id
    const dynamicMatch = segment.match(DYNAMIC_SEGMENT_REGEX);
    if (dynamicMatch) {
      params.push({
        name: dynamicMatch[1],
        type: 'single',
        position: index,
      });
      return `:${dynamicMatch[1]}`;
    }

    // 普通段
    return segment;
  });

  return {
    convertedPath: convertedSegments.join('/'),
    params,
    isCatchAll,
  };
}

/**
 * 规范化 URL 路径
 */
function normalizeUrlPath(urlPath: string): string {
  // 确保以 / 开头
  if (!urlPath.startsWith('/')) {
    urlPath = '/' + urlPath;
  }

  // 移除末尾的 /（除了根路径）
  if (urlPath !== '/' && urlPath.endsWith('/')) {
    urlPath = urlPath.slice(0, -1);
  }

  // 处理空路径
  if (urlPath === '' || urlPath === '/.') {
    urlPath = '/';
  }

  return urlPath;
}

/**
 * 检查文件扩展名是否支持
 */
function isSupportedExtension(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.some(ext => fileName.endsWith(ext));
}

// ============ 批量解析 ============

/**
 * 批量解析路由
 *
 * @param files - 文件信息列表
 * @param config - 路由发现配置
 * @returns 解析后的路由列表
 */
export function parseRoutes(files: FileInfo[], config: RouteDiscoveryConfig): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  for (const file of files) {
    const route = parseRouteFromFile(file, config);
    if (route) {
      routes.push(route);
    }
  }

  // 按路径排序（静态路由优先于动态路由）
  routes.sort((a, b) => {
    // 静态路由优先
    if (!a.isDynamic && b.isDynamic) return -1;
    if (a.isDynamic && !b.isDynamic) return 1;

    // Catch-all 路由放最后
    if (!a.isCatchAll && b.isCatchAll) return -1;
    if (a.isCatchAll && !b.isCatchAll) return 1;

    // 字母顺序
    return a.urlPath.localeCompare(b.urlPath);
  });

  return routes;
}

/**
 * 检测路由冲突
 *
 * @param routes - 路由列表
 * @returns 冲突的路由对
 */
export function detectRouteConflicts(
  routes: ParsedRoute[]
): Array<{ route1: ParsedRoute; route2: ParsedRoute; reason: string }> {
  const conflicts: Array<{ route1: ParsedRoute; route2: ParsedRoute; reason: string }> = [];
  const staticPaths = new Map<string, ParsedRoute>();

  for (const route of routes) {
    // 检查静态路径重复
    if (!route.isDynamic) {
      const existing = staticPaths.get(route.urlPath);
      if (existing) {
        conflicts.push({
          route1: existing,
          route2: route,
          reason: `重复的静态路由: ${route.urlPath}`,
        });
      } else {
        staticPaths.set(route.urlPath, route);
      }
    }
  }

  // 检查动态路由冲突
  const dynamicRoutes = routes.filter(r => r.isDynamic);
  for (let i = 0; i < dynamicRoutes.length; i++) {
    for (let j = i + 1; j < dynamicRoutes.length; j++) {
      const r1 = dynamicRoutes[i];
      const r2 = dynamicRoutes[j];

      // 按深度启发式判定动态路由冲突：同一深度的两条动态路径会在匹配时二义
      const depth1 = r1.urlPath.split('/').length;
      const depth2 = r2.urlPath.split('/').length;

      if (depth1 === depth2) {
        const pattern1 = r1.urlPath.replace(/:[^/]+/g, '*').replace(/\*[^/]+\??/g, '**');
        const pattern2 = r2.urlPath.replace(/:[^/]+/g, '*').replace(/\*[^/]+\??/g, '**');

        if (pattern1 === pattern2) {
          conflicts.push({
            route1: r1,
            route2: r2,
            reason: `动态路由可能冲突: ${r1.urlPath} 和 ${r2.urlPath}`,
          });
        }
      }
    }
  }

  return conflicts;
}

// ============ 路由匹配 ============

/**
 * 匹配结果
 */
export interface RouteMatch {
  /** 匹配的路由 */
  route: ParsedRoute;
  /** 提取的参数 */
  params: Record<string, string>;
  /** 匹配分数（用于排序） */
  score: number;
}

/**
 * 匹配 URL 到路由
 *
 * @param pathname - 要匹配的 URL 路径
 * @param routes - 路由列表
 * @returns 最佳匹配结果，无匹配时返回 null
 */
export function matchRoute(pathname: string, routes: ParsedRoute[]): RouteMatch | null {
  const normalizedPath = normalizeUrlPath(pathname);
  const pathSegments = normalizedPath.split('/').filter(s => s);

  let bestMatch: RouteMatch | null = null;

  for (const route of routes) {
    const match = tryMatchRoute(pathSegments, route);
    if (match) {
      if (!bestMatch || match.score > bestMatch.score) {
        bestMatch = match;
      }
    }
  }

  return bestMatch;
}

/**
 * 尝试匹配单个路由
 */
function tryMatchRoute(pathSegments: string[], route: ParsedRoute): RouteMatch | null {
  const routeSegments = route.urlPath.split('/').filter(s => s);
  const params: Record<string, string> = {};
  let score = 0;

  // Catch-all 路由可以匹配更长的路径
  if (!route.isCatchAll && pathSegments.length !== routeSegments.length) {
    return null;
  }

  for (let i = 0; i < routeSegments.length; i++) {
    const routeSeg = routeSegments[i];
    const pathSeg = pathSegments[i];

    // 可选 catch-all
    if (routeSeg.startsWith('*') && routeSeg.endsWith('?')) {
      const paramName = routeSeg.slice(1, -1);
      const remaining = pathSegments.slice(i).join('/');
      params[paramName] = remaining || '';
      score += 1;
      break;
    }

    // Catch-all
    if (routeSeg.startsWith('*')) {
      const paramName = routeSeg.slice(1);
      const remaining = pathSegments.slice(i).join('/');
      if (!remaining) return null; // 非可选 catch-all 必须有值
      params[paramName] = remaining;
      score += 2;
      break;
    }

    // 动态参数
    if (routeSeg.startsWith(':')) {
      if (!pathSeg) return null;
      const paramName = routeSeg.slice(1);
      params[paramName] = pathSeg;
      score += 5;
      continue;
    }

    // 静态匹配
    if (routeSeg !== pathSeg) {
      return null;
    }
    score += 10;
  }

  return { route, params, score };
}

// ============ 工具函数 ============

/**
 * 格式化路由列表（用于调试）
 */
export function formatRoutes(routes: ParsedRoute[]): string {
  const lines: string[] = [];
  lines.push('=== 路由列表 ===\n');

  for (const route of routes) {
    const typeIcon = route.type === 'api' ? '🔌' : '📄';
    const dynamicBadge = route.isDynamic ? ' [动态]' : '';
    const catchAllBadge = route.isCatchAll ? ' [Catch-all]' : '';

    lines.push(`${typeIcon} ${route.urlPath}${dynamicBadge}${catchAllBadge}`);
    lines.push(`   → ${route.relativePath}`);

    if (route.params.length > 0) {
      const paramStr = route.params.map(p => `${p.name} (${p.type})`).join(', ');
      lines.push(`   参数: ${paramStr}`);
    }
  }

  return lines.join('\n');
}

/**
 * 生成路由配置（用于运行时路由器）
 *
 * @param routes - 路由列表
 * @returns 路由配置对象
 */
export function generateRouteConfig(routes: ParsedRoute[]): {
  pages: Array<{ path: string; component: string }>;
  apis: Array<{ path: string; handler: string }>;
} {
  const pages: Array<{ path: string; component: string }> = [];
  const apis: Array<{ path: string; handler: string }> = [];

  for (const route of routes) {
    if (route.type === 'api') {
      apis.push({
        path: route.urlPath,
        handler: route.filePath,
      });
    } else {
      pages.push({
        path: route.urlPath,
        component: route.filePath,
      });
    }
  }

  return { pages, apis };
}
