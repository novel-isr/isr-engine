/**
 * 配置加载工具
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import * as esbuild from 'esbuild';
import type { ISRConfig } from '@/types';
import { Logger } from '@/logger/Logger';
import { normalizeEngineConfig } from './normalizeEngineConfig';

// 支持的配置文件列表
const CONFIG_FILES = ['ssr.config.ts', 'ssr.config.js', 'ssr.config.mjs', 'ssr.config.cjs'];

let cachedConfig: ISRConfig | null = null;

export interface LoadConfigOptions {
  forceReload?: boolean;
  cwd?: string;
}

/**
 * 加载项目配置
 * 支持运行时动态更新和加载 ssr.config.ts 等配置文件
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ISRConfig> {
  const { forceReload = false, cwd = process.cwd() } = options;
  const logger = Logger.getInstance();

  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  for (const file of CONFIG_FILES) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) {
      try {
        const importPath = await resolveImportPath(filePath, { forceReload, cwd });

        logger.info(`正在加载配置文件: ${filePath}`);

        // 动态导入
        const module = await import(/* @vite-ignore */ importPath);
        const config = module.default || module;
        const normalized = normalizeEngineConfig(config as ISRConfig);

        cachedConfig = normalized;
        logger.info(`成功加载配置: ${filePath}`);

        return cachedConfig;
      } catch (error: unknown) {
        const err = error as Error & { code?: string };
        logger.error(`加载配置文件失败 ${filePath}:`, err);
        const reason = err.message ? ` —— ${err.message}` : '';
        throw new Error(`加载配置文件失败: ${filePath}${reason}`, { cause: err });
      }
    }
  }

  throw new Error(
    `未找到配置文件：请在项目根目录创建 ${CONFIG_FILES.join(' / ')} 并显式声明 renderMode、revalidate 等运行配置。`
  );
}

async function resolveImportPath(
  filePath: string,
  options: { forceReload: boolean; cwd: string }
): Promise<string> {
  const { forceReload, cwd } = options;

  // Node 原生不支持直接 import .ts（除非用户自行安装 loader）。
  // 为了开箱即用：这里将 .ts 配置用 esbuild 编译/打包为临时 .mjs，再进行 import。
  if (filePath.endsWith('.ts')) {
    const cacheDir = path.join(cwd, '.isr-cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    const stat = fs.statSync(filePath);
    const baseKey = `${filePath}|${stat.mtimeMs}`;
    const key = createHash('sha256').update(baseKey).digest('hex').slice(0, 12);
    const outFile = path.join(cacheDir, `ssr.config.${key}.mjs`);

    if (forceReload || !fs.existsSync(outFile)) {
      const result = await esbuild.build({
        entryPoints: [filePath],
        absWorkingDir: cwd,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: ['node20'],
        sourcemap: 'inline',
        write: false,
        logLevel: 'silent',
        // 保持依赖为 external，避免把整个 node_modules 打进配置产物
        packages: 'external',
      });

      const code = result.outputFiles?.[0]?.text;
      if (!code) {
        throw new Error('配置文件编译失败：未生成输出');
      }
      fs.writeFileSync(outFile, code, 'utf8');
    }

    // 使用 query 参数绕过 ESM 缓存，实现动态重载
    return pathToFileURL(outFile).href + (forceReload ? `?t=${Date.now()}` : '');
  }

  // 非 TS：直接按文件 URL import
  return pathToFileURL(filePath).href + (forceReload ? `?t=${Date.now()}` : '');
}

/**
 * 清除配置缓存
 */
export function clearConfigCache() {
  cachedConfig = null;
}
