/**
 * loadConfig —— 按优先级扫 ssr.config.{ts,js,mjs,cjs}，TS 走 esbuild 编译成 .mjs 后动态 import
 *
 * 测试覆盖：
 *   1) 4 种扩展名的优先级（.ts > .js > .mjs > .cjs）
 *   2) TS 文件通过 esbuild 编译 → .isr-cache/ssr.config.<hash>.mjs
 *   3) 缓存：默认命中；forceReload 绕过缓存 + 绕过 ESM 模块缓存
 *   4) 编译产物按 mtime 写入（mtime 不变 → 复用缓存；mtime 变 → 重新编译）
 *   5) 文件不存在 → 返回 engine 默认配置
 *   6) 加载失败 → 日志打印 + 返回默认
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, clearConfigCache } from '../loadConfig';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'loadcfg-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 在 cwd 下写一个命名配置文件 */
async function writeConfig(cwd: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(cwd, name), content, 'utf8');
}

beforeEach(() => {
  clearConfigCache();
});
afterEach(() => {
  clearConfigCache();
});

describe('loadConfig —— 文件扩展名优先级', () => {
  it('同时存在 .ts 和 .js → 优先用 .ts', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 1111 } };`
      );
      await writeConfig(
        cwd,
        'ssr.config.js',
        `export default { renderMode: 'ssr', isr: { revalidate: 2222 } };`
      );
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('isr');
      expect(config.cache.ttl).toBe(1111);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('只有 .mjs → 加载 .mjs', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.mjs',
        `export default { renderMode: 'ssg', isr: { revalidate: 3333 } };`
      );
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('ssg');
      expect(config.cache.ttl).toBe(3333);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('无任何配置 → 返回默认 config（renderMode:isr, cache.strategy:memory）', async () => {
    const cwd = await mkTmpDir();
    try {
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('isr');
      expect(config.cache.strategy).toBe('memory');
      expect(config.cache.ttl).toBe(3600);
      expect(config.seo?.enabled).toBe(true);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— TS 走 esbuild 编译', () => {
  it('编译成功 → 在 `.isr-cache/` 下生成 .mjs 产物', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
interface Cfg { renderMode: 'isr'; isr: { revalidate: number } }
const config: Cfg = { renderMode: 'isr', isr: { revalidate: 7777 } };
export default config;
`
      );
      const config = await loadConfig({ cwd });
      expect(config.cache.ttl).toBe(7777);

      // 验证缓存目录被创建
      const cacheDir = path.join(cwd, '.isr-cache');
      const entries = await fs.readdir(cacheDir);
      const mjsFiles = entries.filter(e => e.startsWith('ssr.config.') && e.endsWith('.mjs'));
      expect(mjsFiles.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('TS 编译包含类型注解 / 解构 / 箭头函数（esbuild 能处理）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
const compute = (base: number): number => base * 2;
const baseTtl = 1500;
export default {
  renderMode: 'isr' as const,
  isr: { revalidate: compute(baseTtl) },
};
`
      );
      const config = await loadConfig({ cwd });
      expect(config.cache.ttl).toBe(3000);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('业务配置不需要 cache，engine 自动补齐内部 memory 默认值', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
export default {
  renderMode: 'isr' as const,
  isr: { revalidate: 120 },
};
`
      );
      const config = await loadConfig({ cwd });
      expect(config.cache).toEqual({ strategy: 'memory', ttl: 120 });
    } finally {
      await rmTmp(cwd);
    }
  });

  it('历史遗留 cache 字段不会覆盖 isr.revalidate', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.js',
        `
export default {
  renderMode: 'isr',
  isr: { revalidate: 240 },
  cache: { strategy: 'redis', ttl: 9999 },
};
`
      );
      const config = await loadConfig({ cwd });
      expect(config.cache).toEqual({ strategy: 'memory', ttl: 240 });
    } finally {
      await rmTmp(cwd);
    }
  });

  it('保留 runtime 平台配置', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
export const runtime = {
  site: 'https://www.example.com',
  services: {
    api: 'https://api.example.com',
    i18n: 'https://i18n.example.com',
    seo: 'https://seo.example.com',
  },
  redis: { url: 'redis://127.0.0.1:6379', keyPrefix: 'app:' },
  rateLimit: { windowMs: 60000, max: 200 },
};
export default {
  renderMode: 'isr' as const,
  runtime,
  isr: { revalidate: 3600 },
};
`
      );
      const config = await loadConfig({ cwd });
      expect(config.runtime?.site).toBe('https://www.example.com');
      expect(config.runtime?.services?.api).toBe('https://api.example.com');
      expect(config.runtime?.services?.i18n).toBe('https://i18n.example.com');
      expect(config.runtime?.services?.seo).toBe('https://seo.example.com');
      expect(config.runtime?.redis?.keyPrefix).toBe('app:');
      expect(config.runtime?.rateLimit?.max).toBe(200);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— 缓存与 forceReload', () => {
  it('连续两次 loadConfig 默认命中内存缓存（同引用）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 100 } };`
      );
      const a = await loadConfig({ cwd });
      const b = await loadConfig({ cwd });
      expect(b).toBe(a); // 同引用证明走了缓存，没有重新 import
    } finally {
      await rmTmp(cwd);
    }
  });

  it('forceReload=true → 绕过缓存，读到文件系统最新内容', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 100 } };`
      );
      const a = await loadConfig({ cwd });
      expect(a.cache.ttl).toBe(100);

      // 覆盖写：改到 500
      await new Promise(r => setTimeout(r, 10)); // 保证 mtime 递增
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 500 } };`
      );

      // 不加 forceReload → 返回缓存的老值
      const cached = await loadConfig({ cwd });
      expect(cached.cache.ttl).toBe(100);

      // 加 forceReload → 拿到新值
      const fresh = await loadConfig({ cwd, forceReload: true });
      expect(fresh.cache.ttl).toBe(500);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('修改 .ts + forceReload → 反映最新内容', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 100 } };`
      );
      const a = await loadConfig({ cwd });
      expect(a.cache.ttl).toBe(100);

      // 改文件内容 —— 写入后延迟一点让 mtime 不同（确保 esbuild 重新编译）
      await new Promise(r => setTimeout(r, 10));
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'ssr', isr: { revalidate: 999 } };`
      );

      const b = await loadConfig({ cwd, forceReload: true });
      expect(b.cache.ttl).toBe(999);
      expect(b.renderMode).toBe('ssr');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('clearConfigCache 后重新加载，读到文件系统最新值', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.js',
        `export default { renderMode: 'isr', isr: { revalidate: 42 } };`
      );
      const a = await loadConfig({ cwd });
      expect(a.cache.ttl).toBe(42);

      clearConfigCache();
      // 换一个 cwd（新文件）验证 clear 后确实去读盘
      const cwd2 = await mkTmpDir();
      await writeConfig(
        cwd2,
        'ssr.config.js',
        `export default { renderMode: 'ssg', isr: { revalidate: 99 } };`
      );
      const b = await loadConfig({ cwd: cwd2 });
      expect(b.cache.ttl).toBe(99);
      await rmTmp(cwd2);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— TS 编译产物缓存复用', () => {
  it('mtime 不变时 → 不重新编译（产物文件数不增长）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', isr: { revalidate: 100 } };`
      );
      await loadConfig({ cwd });
      const dir1 = await fs.readdir(path.join(cwd, '.isr-cache'));

      clearConfigCache();
      await loadConfig({ cwd });
      const dir2 = await fs.readdir(path.join(cwd, '.isr-cache'));

      // hash = sha256(path + mtime) —— 未改文件，产物文件名不变，数量一致
      expect(dir2.length).toBe(dir1.length);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— 加载失败兜底', () => {
  it('.ts 顶层抛错 → 回退默认配置（不崩）', async () => {
    const cwd = await mkTmpDir();
    try {
      // 顶层执行就 throw —— 动态 import 会 reject，loadConfig 应兜底
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
throw new Error('intentional boom at module top level');
export default { renderMode: 'ssr', isr: { revalidate: 1 } };
`
      );
      const config = await loadConfig({ cwd });
      // 加载失败走默认配置
      expect(config.renderMode).toBe('isr');
      expect(config.cache.strategy).toBe('memory');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('空 cwd 目录 → 使用默认配置不崩', async () => {
    const cwd = await mkTmpDir();
    try {
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('isr');
      expect(config.cache.strategy).toBe('memory');
    } finally {
      await rmTmp(cwd);
    }
  });
});
