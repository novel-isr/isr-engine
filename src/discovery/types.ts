/**
 * 发现模块类型定义
 */

/** 组件类型 */
export type ComponentType = 'server' | 'client';

/**
 * 路由类型
 * - page: 页面组件
 * - api: API 路由
 * - layout: 布局组件
 * - component: 普通组件
 */
export type RouteType = 'page' | 'api' | 'layout' | 'component';

/**
 * 支持的文件扩展名
 */
export const SUPPORTED_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'] as const;

/** 组件元数据 */
export interface ComponentMetadata {
  id: string;
  name: string;
  path: string;
  type: ComponentType;
  exports: string[];
}

/** 路由元数据 */
export interface RouteMetadata {
  urlPath: string;
  filePath: string;
  type: RouteType;
}

/** 扫描结果 */
export interface ScanResult {
  routes: RouteMetadata[];
  components: ComponentMetadata[];
}

/** 文件信息 —— content 仅在需要内容解析（如组件元数据）时填充 */
export interface FileInfo {
  absolutePath: string;
  relativePath: string;
  content?: string;
}

/** 路由发现器配置 */
export interface RouteDiscoveryConfig {
  /** 项目根目录 */
  rootDir: string;
  /** 源码目录（相对于 rootDir） */
  srcDir: string;
  /** 页面目录模式（Pages Router） */
  pagesDir: string;
  /** 自定义路由目录（可选） */
  routesDir?: string;
}

/** 组件发现器配置 */
export interface ComponentDiscoveryConfig {
  /** 项目根目录 */
  rootDir: string;
  /** 源码目录（相对于 rootDir） */
  srcDir: string;
}
