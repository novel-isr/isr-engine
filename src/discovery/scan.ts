/**
 * 目录扫描器 —— 轻量文件发现（用于 engine 启动日志 / sitemap 路由枚举）
 *
 * 精简后只做：
 *   - 扫描 pages 目录计数页面路由
 *   - 扫描 api 目录计数 API 路由
 *   - 扫描 components 目录解析组件元数据
 *
 * "use client" / "use server" 指令识别、路径转路由、动态段解析等，
 * 全部交给 @vitejs/plugin-rsc 在构建/运行时完成。本模块不再重造。
 */

import path from 'node:path';
import { parseComponents, type EnhancedComponentMetadata } from './componentDiscovery';
import { isCodeFile, isTestFile, readDirRecursive, readFileHeader } from './fileSystem';
import type { ComponentMetadata, FileInfo } from './types';

export interface ScanConfig {
  /** 页面目录，默认 src/pages */
  pagesDir: string;
  /** API 目录，默认 src/api */
  apiDir: string;
  /** 组件目录列表，默认 ['src/components'] */
  componentDirs: string[];
  /** 是否扫描组件，默认 true */
  scanComponents: boolean;
  /** 是否启用 API 路由扫描，默认 true */
  enableApiRoutes: boolean;
  /** 只读取文件头部（性能优化），默认 true */
  headerOnly: boolean;
  /** 头部行数，默认 50 */
  headerLines: number;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  pagesDir: 'src/pages',
  apiDir: 'src/api',
  componentDirs: ['src/components'],
  scanComponents: true,
  enableApiRoutes: true,
  headerOnly: true,
  headerLines: 50,
};

export interface ScanResult {
  /** 扫描到的路由（页面 + API） */
  routes: {
    pages: FileInfo[];
    apis: FileInfo[];
  };
  /** 组件元数据 */
  components: EnhancedComponentMetadata[] | ComponentMetadata[];
  /** 扫描耗时（毫秒） */
  scanTime: number;
}

async function collectFileInfos(baseDir: string, dir: string): Promise<FileInfo[]> {
  const fullPath = path.join(baseDir, dir);
  const files: FileInfo[] = [];
  try {
    const filePaths = await readDirRecursive(fullPath);
    for (const filePath of filePaths) {
      if (!isCodeFile(filePath) || isTestFile(filePath)) continue;
      files.push({
        absolutePath: filePath,
        relativePath: path.relative(baseDir, filePath),
      });
    }
  } catch {
    // 目录不存在 —— 静默跳过（消费者可能不使用某个目录）
  }
  return files;
}

async function collectComponentsWithContent(
  baseDir: string,
  dirs: string[],
  headerOnly: boolean,
  headerLines: number
): Promise<Array<FileInfo & { content: string }>> {
  const files: Array<FileInfo & { content: string }> = [];
  for (const dir of dirs) {
    const fullPath = path.join(baseDir, dir);
    try {
      const filePaths = await readDirRecursive(fullPath);
      for (const filePath of filePaths) {
        if (!isCodeFile(filePath) || isTestFile(filePath)) continue;
        const content = headerOnly
          ? await readFileHeader(filePath, headerLines * 80)
          : await (await import('node:fs/promises')).readFile(filePath, 'utf-8');
        files.push({
          absolutePath: filePath,
          relativePath: path.relative(baseDir, filePath),
          content,
        });
      }
    } catch {
      // 目录不存在 —— 跳过
    }
  }
  return files;
}

/**
 * 扫描项目目录
 */
export async function scanProject(
  projectRoot: string,
  config: Partial<ScanConfig> = {}
): Promise<ScanResult> {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_SCAN_CONFIG, ...config };

  const pages = await collectFileInfos(projectRoot, cfg.pagesDir);
  const apis = cfg.enableApiRoutes ? await collectFileInfos(projectRoot, cfg.apiDir) : [];

  let components: EnhancedComponentMetadata[] = [];
  if (cfg.scanComponents && cfg.componentDirs.length > 0) {
    const componentFiles = await collectComponentsWithContent(
      projectRoot,
      cfg.componentDirs,
      cfg.headerOnly,
      cfg.headerLines
    );
    components = parseComponents(componentFiles);
  }

  return {
    routes: { pages, apis },
    components,
    scanTime: Date.now() - startTime,
  };
}

/**
 * 仅扫描路由文件（不解析组件）
 */
export async function scanRoutes(
  projectRoot: string,
  config: Partial<Pick<ScanConfig, 'pagesDir' | 'apiDir' | 'enableApiRoutes'>> = {}
): Promise<ScanResult['routes']> {
  const cfg = { ...DEFAULT_SCAN_CONFIG, ...config };
  const pages = await collectFileInfos(projectRoot, cfg.pagesDir);
  const apis = cfg.enableApiRoutes ? await collectFileInfos(projectRoot, cfg.apiDir) : [];
  return { pages, apis };
}

/**
 * 仅扫描组件
 */
export async function scanComponents(
  projectRoot: string,
  componentDirs: string[] = ['src/components']
): Promise<EnhancedComponentMetadata[]> {
  const files = await collectComponentsWithContent(projectRoot, componentDirs, true, 50);
  return parseComponents(files);
}
