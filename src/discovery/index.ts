/**
 * Discovery 模块入口（精简版）
 *
 * plugin-rsc 模式下引擎只需要"扫描磁盘统计文件"这个能力：
 *   - CLI stats 命令打印路由/组件数量
 *   - ISREngine 启动日志
 *   - SEO 引擎生成 sitemap 时的路由枚举
 *
 * "use client" / "use server" 指令识别、AST 边界分析、client/server proxy
 * 代码生成等能力，**全部由 `@vitejs/plugin-rsc` 在编译期处理**，engine 不再
 * 维护平行实现。
 */

// 类型
export type {
  ComponentMetadata,
  ComponentType,
  FileInfo,
  RouteDiscoveryConfig,
  RouteMetadata,
  RouteType,
} from './types';
export { SUPPORTED_EXTENSIONS } from './types';

// 文件系统
export {
  readDirRecursive,
  readFileHeader,
  isCodeFile,
  isTestFile,
  shouldSkipFile,
  getRelativePath,
  directoryExists,
} from './fileSystem';

// 路由解析（file-based routing 分析器）
export {
  parseRouteFromFile,
  parseRoutes,
  detectRouteConflicts,
  matchRoute,
  formatRoutes,
  generateRouteConfig,
  type ParsedRoute,
  type RouteMatch,
  type DynamicParam,
} from './routeDiscovery';

// 组件元数据
export {
  parseComponentFromFile,
  parseComponents,
  extractExports,
  generateComponentId,
  extractComponentName,
  filterClientComponents,
  filterServerComponents,
  getComponentStats,
  type ComponentStats,
  type EnhancedComponentMetadata,
} from './componentDiscovery';

// 主入口（ISREngine.initialize 使用）
export {
  scanProject,
  scanRoutes,
  scanComponents,
  DEFAULT_SCAN_CONFIG,
  type ScanConfig,
  type ScanResult,
} from './scan';
