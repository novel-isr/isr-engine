/**
 * Vite Manifest 类型定义
 *
 * @description Vite 构建产出的 manifest.json 结构
 * @see https://vite.dev/guide/backend-integration.html
 */

/**
 * Vite Manifest Chunk
 * @description 对应 Vite 官方 ManifestChunk 接口
 * @see https://vite.dev/guide/backend-integration.html
 */
export interface ManifestChunk {
  /** 输入文件名（如果已知） */
  src?: string;
  /** 输出文件名 */
  file: string;
  /** 该 chunk 导入的 CSS 文件列表（仅 JS chunk） */
  css?: string[];
  /** 该 chunk 导入的资源文件列表，不含 CSS（仅 JS chunk） */
  assets?: string[];
  /** 是否为入口点 */
  isEntry?: boolean;
  /** chunk/资源名称（如果已知） */
  name?: string;
  /** 是否为动态入口点（仅 JS chunk） */
  isDynamicEntry?: boolean;
  /** 静态导入的 chunk 列表，值为 manifest 的 key（仅 JS chunk） */
  imports?: string[];
  /** 动态导入的 chunk 列表，值为 manifest 的 key（仅 JS chunk） */
  dynamicImports?: string[];
}

/**
 * Vite Manifest
 * @description Record<name, chunk> 结构，key 为相对于项目根目录的源文件路径
 */
export type ViteManifest = Record<string, ManifestChunk>;

/**
 * 标准化的资源信息
 */
export interface AssetInfo {
  /** JavaScript 文件路径 */
  js: string;
  /** CSS 文件路径列表 */
  css: string[];
  /** 需要 modulepreload 的依赖模块 */
  preloadModules: string[];
  /** 静态资源列表 */
  assets: string[];
  /** 是否为入口文件 */
  isEntry: boolean;
}

/**
 * 解析后的 Manifest
 */
export interface ParsedManifest {
  /** Manifest 文件路径 */
  filePath: string;
  /** 入口模块映射 */
  entries: Map<string, AssetInfo>;
  /** 所有模块映射 */
  modules: Map<string, AssetInfo>;
  /** 原始数据 */
  raw: ViteManifest;
}

/**
 * Manifest 加载配置
 */
export interface ManifestConfig {
  /** 项目根目录 */
  rootDir: string;
  /** 自定义 Manifest 路径 */
  manifestPath?: string;
  /** 静态资源公共路径前缀 */
  publicPath?: string;
}
