/**
 * 组件发现器
 *
 * 核心设计：
 * 1. 所有组件默认是 Server Component (RSC)
 * 2. 只有显式标记 'use client' 的组件才是 Client Component
 * 3. 使用 AST 解析指令和导出，确保准确性
 * 4. 支持边界传播分析
 */

import { parseComponentType, hasClientDirective, hasServerDirective } from './directiveParser';
import { getExportNames, parseExports } from './exportParser';
import type { ComponentMetadata, ComponentType, FileInfo } from './types';

/**
 * 增强的组件元数据
 */
export interface EnhancedComponentMetadata extends ComponentMetadata {
  /** 是否显式标记为客户端 */
  hasClientDirective: boolean;
  /** 是否显式标记为服务端（Server Actions） */
  hasServerDirective: boolean;
  /** 是否有默认导出 */
  hasDefaultExport: boolean;
  /** 命名导出列表 */
  namedExports: string[];
}

/**
 * 从文件内容解析组件类型
 * 默认为 server，只有 'use client' 才是 client
 */
export { parseComponentType } from './directiveParser';

/**
 * 从文件内容提取导出（使用 AST）
 */
export function extractExports(content: string): string[] {
  return getExportNames(content);
}

/**
 * 生成组件 ID
 */
export function generateComponentId(relativePath: string): string {
  return relativePath.replace(/[\\/]/g, '_').replace(/\.(tsx|jsx|ts|js)$/, '');
}

/**
 * 从路径提取组件名称
 */
export function extractComponentName(relativePath: string): string {
  const fileName = relativePath.split(/[\\/]/).pop() || '';
  return fileName.replace(/\.(tsx|jsx|ts|js)$/, '');
}

/**
 * 从文件信息解析组件元数据
 */
export function parseComponentFromFile(fileInfo: FileInfo): EnhancedComponentMetadata {
  const { absolutePath, relativePath, content } = fileInfo;
  // 没有内容时，仅返回基础元数据（文件名 / 路径），不进行 AST 分析
  const sourceText = content ?? '';

  const componentType = parseComponentType(sourceText);
  const exportResult = parseExports(sourceText);
  const hasClient = hasClientDirective(sourceText);
  const hasServer = hasServerDirective(sourceText);

  return {
    id: generateComponentId(relativePath),
    name: extractComponentName(relativePath),
    path: absolutePath,
    type: componentType,
    exports: getExportNames(sourceText),
    hasClientDirective: hasClient,
    hasServerDirective: hasServer,
    hasDefaultExport: exportResult.hasDefault,
    namedExports: exportResult.namedExports,
  };
}

/**
 * 批量解析组件
 */
export function parseComponents(files: FileInfo[]): EnhancedComponentMetadata[] {
  return files.map(parseComponentFromFile);
}

/**
 * 过滤客户端组件
 */
export function filterClientComponents(
  components: EnhancedComponentMetadata[]
): EnhancedComponentMetadata[] {
  return components.filter(c => c.type === 'client');
}

/**
 * 过滤服务端组件
 */
export function filterServerComponents(
  components: EnhancedComponentMetadata[]
): EnhancedComponentMetadata[] {
  return components.filter(c => c.type === 'server');
}

/**
 * 统计组件类型分布
 */
export interface ComponentStats {
  total: number;
  client: number;
  server: number;
  withClientDirective: number;
  withServerDirective: number;
}

/**
 * 获取组件统计信息
 */
export function getComponentStats(components: EnhancedComponentMetadata[]): ComponentStats {
  return {
    total: components.length,
    client: components.filter(c => c.type === 'client').length,
    server: components.filter(c => c.type === 'server').length,
    withClientDirective: components.filter(c => c.hasClientDirective).length,
    withServerDirective: components.filter(c => c.hasServerDirective).length,
  };
}
