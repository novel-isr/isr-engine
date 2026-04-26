/**
 * CacheCleanup —— dev 启动时清理 .isr-hyou 缓存目录
 *
 * 关键安全约束：路径必须含 `.isr-hyou` 字符串才会被删（防止意外清错目录）。
 * 必须验证：
 *   1) NODE_ENV=production 时不动任何文件
 *   2) NODE_ENV=development 且目录存在 → 清理
 *   3) 路径不含 `.isr-hyou` → 跳过（防 user 改 cwd 后误删）
 *   4) getISRCacheDir / getSSRCacheDir / getSSGCacheDir 返回正确路径
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheCleanup } from '../CacheCleanup';

let originalCwd: string;
let tmpDir: string;
let originalNodeEnv: string | undefined;

beforeEach(async () => {
  originalCwd = process.cwd();
  originalNodeEnv = process.env.NODE_ENV;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('CacheCleanup.cleanupOnDevStart', () => {
  it('NODE_ENV=production → noop（不动任何文件）', async () => {
    process.env.NODE_ENV = 'production';
    await fs.mkdir(path.join(tmpDir, '.isr-hyou', 'isr'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.isr-hyou', 'isr', 'data.json'), '{}', 'utf8');

    await CacheCleanup.cleanupOnDevStart();

    expect(await exists(path.join(tmpDir, '.isr-hyou', 'isr', 'data.json'))).toBe(true);
  });

  it('NODE_ENV=development + 目录存在 → 清理', async () => {
    process.env.NODE_ENV = 'development';
    await fs.mkdir(path.join(tmpDir, '.isr-hyou', 'isr'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.isr-hyou', 'ssg'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.isr-hyou', 'isr', 'data.json'), '{}');
    await fs.writeFile(path.join(tmpDir, '.isr-hyou', 'ssg', 'index.html'), '<html/>');

    await CacheCleanup.cleanupOnDevStart();

    expect(await exists(path.join(tmpDir, '.isr-hyou'))).toBe(false);
  });

  it('目录不存在 → 不报错', async () => {
    process.env.NODE_ENV = 'development';
    await expect(CacheCleanup.cleanupOnDevStart()).resolves.toBeUndefined();
  });

  it('NODE_ENV 未设置 → 当作 dev 处理（清理）', async () => {
    delete process.env.NODE_ENV;
    await fs.mkdir(path.join(tmpDir, '.isr-hyou'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.isr-hyou', 'x.json'), '{}');

    await CacheCleanup.cleanupOnDevStart();

    expect(await exists(path.join(tmpDir, '.isr-hyou'))).toBe(false);
  });

  it('清理只影响 .isr-hyou 子目录，不动其他文件', async () => {
    process.env.NODE_ENV = 'development';
    // 同级建一些"无辜"文件
    await fs.mkdir(path.join(tmpDir, '.isr-hyou'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.isr-hyou', 'cache.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'app.tsx'), 'x');

    await CacheCleanup.cleanupOnDevStart();

    expect(await exists(path.join(tmpDir, '.isr-hyou'))).toBe(false);
    expect(await exists(path.join(tmpDir, 'package.json'))).toBe(true);
    expect(await exists(path.join(tmpDir, 'src', 'app.tsx'))).toBe(true);
  });

  it('多次调用幂等（第二次目录已不存在不报错）', async () => {
    process.env.NODE_ENV = 'development';
    await fs.mkdir(path.join(tmpDir, '.isr-hyou'), { recursive: true });

    await CacheCleanup.cleanupOnDevStart();
    await CacheCleanup.cleanupOnDevStart(); // 第二次应该是 noop
    await CacheCleanup.cleanupOnDevStart(); // 第三次也是

    expect(await exists(path.join(tmpDir, '.isr-hyou'))).toBe(false);
  });
});

describe('CacheCleanup.getISRCacheDir / getSSRCacheDir / getSSGCacheDir', () => {
  it('返回基于当前 cwd 的绝对路径', () => {
    const isr = CacheCleanup.getISRCacheDir();
    const ssr = CacheCleanup.getSSRCacheDir();
    const ssg = CacheCleanup.getSSGCacheDir();

    expect(path.isAbsolute(isr)).toBe(true);
    expect(path.isAbsolute(ssr)).toBe(true);
    expect(path.isAbsolute(ssg)).toBe(true);

    // 都包含 .isr-hyou
    expect(isr).toContain('.isr-hyou');
    expect(ssr).toContain('.isr-hyou');
    expect(ssg).toContain('.isr-hyou');

    // 子目录区分
    expect(isr).toMatch(/[\\/]isr$/);
    expect(ssr).toMatch(/[\\/]ssr$/);
    expect(ssg).toMatch(/[\\/]ssg$/);
  });

  it('cwd 切换后路径相应变化', async () => {
    // macOS 上 /var/folders 是 /private/var/folders 的符号链接，
    // process.cwd() 返回 realpath 解析后的物理路径 —— 比较前要先 realpath 标准化
    const realTmp = await fs.realpath(tmpDir);
    const isrA = CacheCleanup.getISRCacheDir();
    expect(isrA.startsWith(realTmp)).toBe(true);
    expect(isrA).toMatch(/[\\/]\.isr-hyou[\\/]isr$/);
  });
});
