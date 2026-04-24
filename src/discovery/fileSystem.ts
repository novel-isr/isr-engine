/**
 * 文件系统工具函数
 * 提供文件遍历、读取等基础能力
 */

import fs from 'fs/promises';
import path from 'path';

/** 代码文件扩展名 */
const CODE_EXTENSIONS = /\.(tsx|jsx|ts|js)$/;

/** 测试文件模式 */
const TEST_FILE_PATTERN = /\.(test|spec)\./;

/** 需要忽略的目录 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.isr-hyou',
  '__tests__',
  '__mocks__',
]);

/**
 * 递归读取目录下所有文件
 */
export async function readDirRecursive(dir: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      dirents.map(async dirent => {
        const fullPath = path.resolve(dir, dirent.name);

        if (dirent.isDirectory()) {
          if (IGNORED_DIRS.has(dirent.name)) {
            return [];
          }
          return readDirRecursive(fullPath);
        }

        return [fullPath];
      })
    );

    return files.flat();
  } catch {
    return [];
  }
}

/**
 * 读取文件头部内容（用于检测指令）
 */
export async function readFileHeader(filePath: string, length = 500): Promise<string> {
  try {
    const handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    await handle.close();
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  }
}

/**
 * 判断是否为代码文件
 */
export function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.test(filePath);
}

/**
 * 判断是否为测试文件
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

/**
 * 判断是否应该跳过该文件
 */
export function shouldSkipFile(filePath: string): boolean {
  return !isCodeFile(filePath) || isTestFile(filePath);
}

/**
 * 获取相对路径
 */
export function getRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath);
}

/**
 * 检查目录是否存在
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
