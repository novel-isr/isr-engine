/**
 * Vite Manifest 加载器
 *
 * @description 加载 Vite 构建产出的 Manifest 文件，用于生产环境 SSR 资源注入
 *
 * @example
 * ```typescript
 * const manifest = ManifestLoader.load({ rootDir: process.cwd() });
 * if (manifest) {
 *   const assets = ManifestLoader.getEntryAssets('src/entry.tsx');
 *   console.log(assets.js); // '/assets/entry.a1b2c3.js'
 * }
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Logger } from '@/logger/Logger';
import type {
  ViteManifest,
  ManifestChunk,
  AssetInfo,
  ParsedManifest,
  ManifestConfig,
} from './types';

/** Vite Manifest 默认路径 (按优先级排列) */
const MANIFEST_PATHS = [
  'dist/.vite/manifest.json', // Vite 5+
  'dist/client/.vite/manifest.json', // SSR client build
  'dist/manifest.json', // Vite 4
] as const;

const MANIFEST_ENTRY_CANDIDATES = [
  'src/entry.tsx',
  'src/entry.ts',
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'src/App.tsx',
  'src/App.ts',
];

/**
 * Vite Manifest 加载器
 */
export class ManifestLoader {
  private static logger = Logger.getInstance();
  private static manifest: ParsedManifest | null = null;
  private static publicPath = '/';

  // 仅 static 用法，不允许 new ManifestLoader() ——
  // 私有空构造函数确保 TypeScript / 调用方都拒绝实例化
  private constructor() {
    /* static-only class */
  }

  /**
   * 加载 Manifest
   * @returns 解析后的 Manifest，失败返回 null
   */
  static load(config: ManifestConfig): ParsedManifest | null {
    const { rootDir, manifestPath, publicPath = '/' } = config;
    this.publicPath = publicPath.endsWith('/') ? publicPath : `${publicPath}/`;

    const absolutePath = manifestPath
      ? resolve(rootDir, manifestPath)
      : this.detectManifestPath(rootDir);

    if (!absolutePath) {
      return null;
    }

    return this.loadFromPath(absolutePath);
  }

  /**
   * 检测 Manifest 路径
   */
  private static detectManifestPath(rootDir: string): string | null {
    for (const relativePath of MANIFEST_PATHS) {
      const absolutePath = resolve(rootDir, relativePath);
      if (existsSync(absolutePath)) {
        this.logger.info(`📦 检测到 Manifest: ${relativePath}`);
        return absolutePath;
      }
    }

    this.logger.warn(
      `⚠️ 未找到 Manifest 文件，请确保已执行 vite build 并设置 build.manifest: true`
    );
    return null;
  }

  /**
   * 从路径加载 Manifest
   */
  private static loadFromPath(absolutePath: string): ParsedManifest | null {
    if (!existsSync(absolutePath)) {
      this.logger.error(`Manifest 文件不存在: ${absolutePath}`);
      return null;
    }

    try {
      const content = readFileSync(absolutePath, 'utf-8');
      const raw = JSON.parse(content) as ViteManifest;
      const parsed = this.parse(raw, absolutePath);

      this.manifest = parsed;
      this.logger.info(
        `✅ Manifest 加载成功: ${parsed.entries.size} 个入口，${parsed.modules.size} 个模块`
      );

      return parsed;
    } catch (error) {
      this.logger.error(
        `Manifest 解析失败: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * 解析 Vite Manifest
   */
  private static parse(raw: ViteManifest, filePath: string): ParsedManifest {
    const entries = new Map<string, AssetInfo>();
    const modules = new Map<string, AssetInfo>();

    for (const [modulePath, chunk] of Object.entries(raw)) {
      const assetInfo = this.toAssetInfo(chunk);
      modules.set(modulePath, assetInfo);

      if (chunk.isEntry) {
        entries.set(modulePath, assetInfo);
      }
    }

    return { filePath, entries, modules, raw };
  }

  /**
   * 转换为 AssetInfo
   */
  private static toAssetInfo(chunk: ManifestChunk): AssetInfo {
    const preloadModules = this.collectPreloadModules(chunk);

    return {
      js: this.normalizePath(chunk.file),
      css: this.uniqueValues((chunk.css ?? []).map(css => this.normalizePath(css))),
      preloadModules: this.uniqueValues(preloadModules),
      assets: this.uniqueValues((chunk.assets ?? []).map(asset => this.normalizePath(asset))),
      isEntry: chunk.isEntry ?? false,
    };
  }

  /**
   * 收集预加载模块（包含静态与动态导入），并统一为 manifest key 风格
   */
  private static collectPreloadModules(chunk: ManifestChunk): string[] {
    const imports = chunk.imports ?? [];
    const dynamicImports = chunk.dynamicImports ?? [];
    const merged = [...imports, ...dynamicImports];

    return merged
      .map(entry => this.normalizeManifestPath(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  private static uniqueValues(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  /**
   * 标准化 manifest 路径（便于跨环境匹配）
   */
  private static normalizeManifestPath(path: string): string {
    return path
      .split('?')[0]
      .split('#')[0]
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '');
  }

  /**
   * 构建匹配候选（含带/不带前导斜杠、去扩展名）
   */
  private static buildMatchVariants(raw: string): string[] {
    const normalized = this.normalizeManifestPath(raw);
    if (!normalized) {
      return [];
    }

    const noExt = normalized.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/i, '');
    return Array.from(new Set([normalized, `/${normalized}`, noExt, `/${noExt}`]));
  }

  /**
   * 在 manifest 映射中查找候选匹配 key
   */
  private static findModuleKeyByCandidates(
    source: Map<string, AssetInfo>,
    candidates: string[]
  ): string | undefined {
    const normalizedCandidates = new Set<string>();
    for (const candidate of candidates) {
      for (const variant of this.buildMatchVariants(candidate)) {
        normalizedCandidates.add(variant);
      }
    }

    for (const key of source.keys()) {
      for (const variant of this.buildMatchVariants(key)) {
        if (normalizedCandidates.has(variant)) {
          return key;
        }
      }
    }

    return undefined;
  }

  /**
   * 解析依赖 key（imports）
   */
  private static normalizeImportId(importId: string): string {
    const normalized = this.normalizeManifestPath(importId);
    return normalized;
  }

  /**
   * 规范化路径
   */
  private static normalizePath(path: string): string {
    if (path.startsWith('/') || path.startsWith('http')) {
      return path;
    }
    return `${this.publicPath}${path}`;
  }

  /**
   * 获取已加载的 Manifest
   */
  static getManifest(): ParsedManifest | null {
    return this.manifest;
  }

  /**
   * 获取入口资源信息
   */
  static getEntryAssets(entryPath: string): AssetInfo | null {
    if (!this.manifest) return null;

    const directKey = this.findModuleKeyByCandidates(this.manifest.entries, [entryPath]);
    if (directKey) {
      return this.manifest.entries.get(directKey) ?? null;
    }

    const normalizedPath = this.normalizeManifestPath(entryPath);
    if (normalizedPath) {
      const normalizedKey = this.findModuleKeyByCandidates(this.manifest.entries, [normalizedPath]);
      if (normalizedKey) {
        return this.manifest.entries.get(normalizedKey) ?? null;
      }
    }

    return null;
  }

  /**
   * 生成入口候选 key（兼容 build 产物和路径写法差异）
   */
  private static buildEntryCandidates(entryPath?: string): string[] {
    const candidates = new Set<string>();

    const collect = (rawPath: string) => {
      const normalized = rawPath.replace(/^\/+/, '').trim();
      if (!normalized) {
        return;
      }

      candidates.add(normalized);
      candidates.add(`/${normalized}`);

      const noExt = normalized.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/i, '');
      candidates.add(noExt);
      candidates.add(`/${noExt}`);
      if (noExt.includes('.')) {
        candidates.add(noExt.replace(/\.([^.]+)$/, ''));
      }
    };

    if (entryPath) {
      collect(entryPath);
    } else {
      for (const candidate of MANIFEST_ENTRY_CANDIDATES) {
        collect(candidate);
      }
    }

    return Array.from(candidates);
  }

  /**
   * 按候选路径解析入口资源，找不到时回退到最接近入口的 chunk
   */
  static resolveEntryAssets(entryPath?: string): AssetInfo | null {
    if (!this.manifest) return null;

    for (const candidate of this.buildEntryCandidates(entryPath)) {
      const matched = this.getEntryAssets(candidate);
      if (matched) return matched;
    }

    for (const [key, asset] of this.manifest.entries) {
      if (asset.js && !/vendor|router|polyfill/i.test(key)) {
        return asset;
      }
    }

    for (const [, asset] of this.manifest.entries) {
      if (asset.js) {
        return asset;
      }
    }

    return null;
  }

  /**
   * 获取模块资源信息
   */
  static getModuleAssets(modulePath: string): AssetInfo | null {
    if (!this.manifest) return null;

    const candidates = this.buildMatchVariants(modulePath);
    const direct = this.findModuleKeyByCandidates(this.manifest.modules, candidates);
    if (direct) {
      return this.manifest.modules.get(direct) ?? null;
    }

    return this.manifest.modules.get(this.normalizeManifestPath(modulePath)) ?? null;
  }

  /**
   * 生成 HTML 资源标签
   */
  static generateHtmlTags(entryPath?: string): { head: string; scripts: string } {
    if (!this.manifest) {
      return { head: '', scripts: '' };
    }

    const headTagSet = new Set<string>();
    const scriptTagSet = new Set<string>();
    const { modules, entries } = this.manifest;

    const processAsset = (asset: AssetInfo) => {
      // CSS
      for (const css of asset.css) {
        headTagSet.add(`<link rel="stylesheet" href="${css}" />`);
      }

      // Module Preload
      for (const preload of asset.preloadModules) {
        const preloadModuleKey = this.findModuleKeyByCandidates(modules, [preload]);
        const module = preloadModuleKey ? modules.get(preloadModuleKey) : null;
        if (module?.js) {
          headTagSet.add(`<link rel="modulepreload" href="${module.js}" />`);
        }
      }

      // Entry Script
      if (asset.isEntry) {
        scriptTagSet.add(`<script type="module" src="${asset.js}"></script>`);
      }
    };

    const entryAsset = this.resolveEntryAssets(entryPath);
    if (entryAsset) {
      processAsset(entryAsset);
    } else {
      for (const asset of entries.values()) {
        processAsset(asset);
      }
    }

    return {
      head: Array.from(headTagSet).join('\n    '),
      scripts: Array.from(scriptTagSet).join('\n    '),
    };
  }
}
