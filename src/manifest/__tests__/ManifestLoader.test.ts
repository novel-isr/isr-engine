/**
 * ManifestLoader —— Vite 构建产物 manifest.json 解析器
 *
 * 测试覆盖：
 *   1) 路径自动探测：dist/.vite/manifest.json（Vite 5+）优先、dist/manifest.json fallback（Vite 4）
 *   2) publicPath 前缀规范化（末尾斜杠补齐）
 *   3) entry / module 映射分离（isEntry=true 才进 entries）
 *   4) 入口候选 key 解析（src/entry.tsx、.ts、.jsx、.js、去扩展名）
 *   5) CSS / modulepreload / <script> HTML tag 生成
 *   6) 跨环境路径匹配（带 `./`、前导斜杠、反斜杠 → 统一 key）
 *   7) manifest 缺失 / JSON 非法 → 返回 null，不崩
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ManifestLoader } from '../ManifestLoader';
import type { ViteManifest } from '../types';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'manifest-'));
}
async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeManifest(
  rootDir: string,
  relative: string,
  manifest: ViteManifest
): Promise<void> {
  const full = path.join(rootDir, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(manifest, null, 2), 'utf8');
}

/** 复位 ManifestLoader 的 static 状态，防止 test 间污染 */
function resetLoader(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ManifestLoader as any).manifest = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ManifestLoader as any).publicPath = '/';
}

beforeEach(resetLoader);
afterEach(resetLoader);

const minimalManifest: ViteManifest = {
  'src/entry.tsx': {
    file: 'assets/entry-abc123.js',
    src: 'src/entry.tsx',
    isEntry: true,
    css: ['assets/entry-abc123.css'],
    imports: ['_shared-xyz.js'],
    assets: [],
  },
  '_shared-xyz.js': {
    file: 'assets/shared-xyz.js',
    imports: [],
  },
  'src/lazy.tsx': {
    file: 'assets/lazy-def456.js',
    src: 'src/lazy.tsx',
    isDynamicEntry: true,
    isEntry: false,
  },
};

describe('ManifestLoader.load —— 路径自动探测', () => {
  it('Vite 5+ 路径 `dist/.vite/manifest.json` 优先', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      // 同时写 Vite 4 的 fallback 位置 —— 不应被选
      await writeManifest(cwd, 'dist/manifest.json', {});
      const result = ManifestLoader.load({ rootDir: cwd });
      expect(result).not.toBeNull();
      expect(result?.filePath).toContain('dist/.vite/manifest.json');
      expect(result?.entries.size).toBe(1);
      expect(result?.modules.size).toBe(3);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('只有 Vite 4 路径 → 加载 `dist/manifest.json`', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd });
      expect(result).not.toBeNull();
      expect(result?.filePath).toMatch(/dist\/manifest\.json$/);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('显式 manifestPath 覆盖自动探测', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'custom/my.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd, manifestPath: 'custom/my.json' });
      expect(result?.filePath).toContain('custom/my.json');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('所有候选路径都不存在 → 返回 null（不崩）', async () => {
    const cwd = await mkTmpDir();
    try {
      expect(ManifestLoader.load({ rootDir: cwd })).toBeNull();
    } finally {
      await rmTmp(cwd);
    }
  });

  it('JSON 非法 → 返回 null', async () => {
    const cwd = await mkTmpDir();
    try {
      const full = path.join(cwd, 'dist/.vite/manifest.json');
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, '{ invalid json', 'utf8');
      expect(ManifestLoader.load({ rootDir: cwd })).toBeNull();
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('ManifestLoader —— AssetInfo 解析', () => {
  it('entries 只包含 isEntry=true 的 chunk', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd });
      expect(result?.entries.has('src/entry.tsx')).toBe(true);
      expect(result?.entries.has('_shared-xyz.js')).toBe(false);
      expect(result?.entries.has('src/lazy.tsx')).toBe(false); // isDynamicEntry 不算 isEntry
    } finally {
      await rmTmp(cwd);
    }
  });

  it('modules 包含所有 chunk（含 shared + dynamic）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd });
      expect(result?.modules.size).toBe(3);
      expect(result?.modules.has('_shared-xyz.js')).toBe(true);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('CSS 路径带 publicPath 前缀', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd, publicPath: '/cdn/' });
      const entry = result?.entries.get('src/entry.tsx');
      expect(entry?.js).toBe('/cdn/assets/entry-abc123.js');
      expect(entry?.css).toEqual(['/cdn/assets/entry-abc123.css']);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('publicPath 缺少末尾 `/` 自动补齐', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd, publicPath: '/static' });
      expect(result?.entries.get('src/entry.tsx')?.js).toBe('/static/assets/entry-abc123.js');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('绝对 URL 或 `/` 开头的 js 不再被 publicPath 重写', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', {
        'src/entry.tsx': {
          file: 'https://cdn.example.com/entry.js',
          isEntry: true,
        },
        'src/other.tsx': {
          file: '/assets/absolute.js',
          isEntry: true,
        },
      });
      const result = ManifestLoader.load({ rootDir: cwd, publicPath: '/cdn/' });
      expect(result?.entries.get('src/entry.tsx')?.js).toBe('https://cdn.example.com/entry.js');
      expect(result?.entries.get('src/other.tsx')?.js).toBe('/assets/absolute.js');
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('ManifestLoader.resolveEntryAssets —— 入口候选匹配', () => {
  it('精确 entry path 匹配', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      const entry = ManifestLoader.resolveEntryAssets('src/entry.tsx');
      expect(entry?.js).toBe('/assets/entry-abc123.js');
      expect(entry?.isEntry).toBe(true);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('带 `/` 前缀 → 识别为等价 key', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      expect(ManifestLoader.resolveEntryAssets('/src/entry.tsx')?.js).toBe(
        '/assets/entry-abc123.js'
      );
    } finally {
      await rmTmp(cwd);
    }
  });

  it('去扩展名也识别（src/entry 匹配 src/entry.tsx）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      expect(ManifestLoader.resolveEntryAssets('src/entry')?.js).toBe('/assets/entry-abc123.js');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('未传 entryPath → 从内置候选列表 (src/entry.tsx / main.tsx / ...) 找首个匹配', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', {
        'src/main.tsx': {
          file: 'assets/main-999.js',
          isEntry: true,
        },
      });
      ManifestLoader.load({ rootDir: cwd });
      const entry = ManifestLoader.resolveEntryAssets();
      expect(entry?.js).toBe('/assets/main-999.js');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('候选都未命中 → fallback 到 entries 中第一个非 vendor/router/polyfill 的 chunk', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', {
        'vendor.js': { file: 'assets/vendor.js', isEntry: true },
        'router.js': { file: 'assets/router.js', isEntry: true },
        'polyfill.js': { file: 'assets/polyfill.js', isEntry: true },
        'src/custom.tsx': { file: 'assets/custom.js', isEntry: true },
      });
      ManifestLoader.load({ rootDir: cwd });
      const entry = ManifestLoader.resolveEntryAssets('src/nonexistent.tsx');
      // vendor/router/polyfill 先过滤，custom.tsx 被选
      expect(entry?.js).toBe('/assets/custom.js');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('未加载 manifest 时 resolveEntryAssets 返回 null', () => {
    expect(ManifestLoader.resolveEntryAssets('src/entry.tsx')).toBeNull();
  });
});

describe('ManifestLoader.generateHtmlTags —— HTML 注入', () => {
  it('生成 <link rel="stylesheet"> + <link rel="modulepreload"> + <script type="module">', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      const { head, scripts } = ManifestLoader.generateHtmlTags('src/entry.tsx');
      expect(head).toContain('<link rel="stylesheet" href="/assets/entry-abc123.css"');
      expect(head).toContain('<link rel="modulepreload" href="/assets/shared-xyz.js"');
      expect(scripts).toContain('<script type="module" src="/assets/entry-abc123.js"></script>');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('未加载 manifest → 返回空字符串（不 throw）', () => {
    const { head, scripts } = ManifestLoader.generateHtmlTags();
    expect(head).toBe('');
    expect(scripts).toBe('');
  });

  it('CSS 去重（多次引用同一文件不重复 tag）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', {
        'src/entry.tsx': {
          file: 'assets/e.js',
          isEntry: true,
          css: ['assets/shared.css', 'assets/shared.css', 'assets/shared.css'],
        },
      });
      ManifestLoader.load({ rootDir: cwd });
      const { head } = ManifestLoader.generateHtmlTags('src/entry.tsx');
      const matches = head.match(/assets\/shared\.css/g);
      expect(matches?.length).toBe(1);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('ManifestLoader.getModuleAssets —— 模块查询', () => {
  it('精确路径 + 去扩展名匹配', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      expect(ManifestLoader.getModuleAssets('_shared-xyz.js')?.js).toBe('/assets/shared-xyz.js');
      expect(ManifestLoader.getModuleAssets('src/lazy.tsx')?.js).toBe('/assets/lazy-def456.js');
      // 去扩展名
      expect(ManifestLoader.getModuleAssets('src/lazy')?.js).toBe('/assets/lazy-def456.js');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('不存在的 module 返回 null', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      ManifestLoader.load({ rootDir: cwd });
      expect(ManifestLoader.getModuleAssets('src/nowhere.tsx')).toBeNull();
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('ManifestLoader —— 实际 existsSync 触达校验', () => {
  it('load 后磁盘上的 manifest 文件真实存在（sanity check）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeManifest(cwd, 'dist/.vite/manifest.json', minimalManifest);
      const result = ManifestLoader.load({ rootDir: cwd });
      expect(existsSync(result!.filePath)).toBe(true);
    } finally {
      await rmTmp(cwd);
    }
  });
});
