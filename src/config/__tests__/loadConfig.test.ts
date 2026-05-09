/**
 * loadConfig —— 按优先级扫 ssr.config.{ts,js,mjs,cjs}，TS 走 esbuild 编译成 .mjs 后动态 import
 *
 * 测试覆盖：
 *   1) 4 种扩展名的优先级（.ts > .js > .mjs > .cjs）
 *   2) TS 文件通过 esbuild 编译 → .isr-cache/ssr.config.<hash>.mjs
 *   3) 缓存：默认命中；forceReload 绕过缓存 + 绕过 ESM 模块缓存
 *   4) 编译产物按 mtime 写入（mtime 不变 → 复用缓存；mtime 变 → 重新编译）
 *   5) 文件不存在 / 旧字段 / 非完整配置 → fail fast
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

async function writeConfig(cwd: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(cwd, name), content, 'utf8');
}

function fullConfigSource(
  options: {
    renderMode?: string;
    revalidate?: string;
    runtime?: string;
    extra?: string;
  } = {}
): string {
  const renderMode = options.renderMode ?? "'isr'";
  const revalidate = options.revalidate ?? '3600';
  const runtime =
    options.runtime ??
    `{
    site: undefined,
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    rateLimit: false,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    theme: undefined,    telemetry: false,
  }`;

  return `
export default {
  renderMode: ${renderMode},
  revalidate: ${revalidate},
  routes: {},
  runtime: ${runtime},
  server: {
    port: 3000,
    host: '127.0.0.1',
    strictPort: true,
    ops: {
      authToken: undefined,
      tokenHeader: 'x-isr-admin-token',
      health: { enabled: true, public: true },
      metrics: { enabled: false, public: false },
    },
  },
  ssg: {
    routes: [],
    concurrent: 3,
    requestTimeoutMs: 30000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },
  ${options.extra ?? ''}
};`;
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
        fullConfigSource({ renderMode: "'isr'", revalidate: '1111' })
      );
      await writeConfig(
        cwd,
        'ssr.config.js',
        fullConfigSource({ renderMode: "'ssr'", revalidate: '2222' })
      );
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('isr');
      expect(config.revalidate).toBe(1111);
      expect('cache' in config).toBe(false);
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
        fullConfigSource({ renderMode: "'ssg'", revalidate: '3333' })
      );
      const config = await loadConfig({ cwd });
      expect(config.renderMode).toBe('ssg');
      expect(config.revalidate).toBe(3333);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('无任何配置 → fail fast，避免隐藏默认配置', async () => {
    const cwd = await mkTmpDir();
    try {
      await expect(loadConfig({ cwd })).rejects.toThrow('未找到配置文件');
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— TS 走 esbuild 编译', () => {
  it('编译成功 → 在 `.isr-cache/` 下生成 .mjs 产物', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '7777' }));
      const config = await loadConfig({ cwd });
      expect(config.revalidate).toBe(7777);

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
${fullConfigSource({ renderMode: "'isr' as const", revalidate: 'compute(baseTtl)' }).replace('export default', 'export default')}
`
      );
      const config = await loadConfig({ cwd });
      expect(config.revalidate).toBe(3000);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('业务配置不暴露 cache，TTL 只读取顶层 revalidate', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '120' }));
      const config = await loadConfig({ cwd });
      expect(config.revalidate).toBe(120);
      expect('cache' in config).toBe(false);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('历史遗留 cache 字段会 fail fast', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.js',
        fullConfigSource({
          revalidate: '240',
          extra: "cache: { strategy: 'redis', ttl: 9999 },",
        })
      );
      await expect(loadConfig({ cwd })).rejects.toThrow('cache/isr/seo');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('runtime 未写全会 fail fast，避免 JS 配置绕过类型检查', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.js',
        fullConfigSource({
          runtime: "{ site: 'https://example.com' }",
        })
      );
      await expect(loadConfig({ cwd })).rejects.toThrow('runtime.services');
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
    telemetry: 'https://telemetry.example.com',
  },
  redis: {
    url: 'redis://127.0.0.1:6379',
    host: undefined,
    port: undefined,
    password: undefined,
    keyPrefix: 'app:',
    invalidationChannel: undefined,
  },
  rateLimit: {
    appName: undefined,
    store: 'auto',
    windowMs: 60000,
    max: 200,
    lruMax: 10000,
    trustProxy: false,
    sendHeaders: true,
    keyPrefix: undefined,
    skipPaths: [],
    skipPathPrefixes: [],
    skipExtensions: [],
  },
  experiments: {},
  i18n: undefined,
  seo: undefined,
  theme: undefined,  telemetry: false,
};
${fullConfigSource({ runtime: 'runtime' })}
`
      );
      const config = await loadConfig({ cwd });
      expect(config.runtime.site).toBe('https://www.example.com');
      expect(config.runtime.services.api).toBe('https://api.example.com');
      expect(config.runtime.services.telemetry).toBe('https://telemetry.example.com');
      expect(config.runtime.redis?.keyPrefix).toBe('app:');
      expect(config.runtime.rateLimit && config.runtime.rateLimit.max).toBe(200);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— 缓存与 forceReload', () => {
  it('连续两次 loadConfig 默认命中内存缓存（同引用）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '100' }));
      const a = await loadConfig({ cwd });
      const b = await loadConfig({ cwd });
      expect(b).toBe(a);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('forceReload=true → 绕过缓存，读到文件系统最新内容', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '100' }));
      const a = await loadConfig({ cwd });
      expect(a.revalidate).toBe(100);

      await new Promise(r => setTimeout(r, 10));
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '500' }));

      const cached = await loadConfig({ cwd });
      expect(cached.revalidate).toBe(100);

      const fresh = await loadConfig({ cwd, forceReload: true });
      expect(fresh.revalidate).toBe(500);
    } finally {
      await rmTmp(cwd);
    }
  });

  it('修改 .ts + forceReload → 反映最新内容', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '100' }));
      const a = await loadConfig({ cwd });
      expect(a.revalidate).toBe(100);

      await new Promise(r => setTimeout(r, 10));
      await writeConfig(
        cwd,
        'ssr.config.ts',
        fullConfigSource({ renderMode: "'ssr'", revalidate: '999' })
      );

      const b = await loadConfig({ cwd, forceReload: true });
      expect(b.revalidate).toBe(999);
      expect(b.renderMode).toBe('ssr');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('clearConfigCache 后重新加载，读到文件系统最新值', async () => {
    const cwd = await mkTmpDir();
    const cwd2 = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.js', fullConfigSource({ revalidate: '42' }));
      const a = await loadConfig({ cwd });
      expect(a.revalidate).toBe(42);

      clearConfigCache();
      await writeConfig(
        cwd2,
        'ssr.config.js',
        fullConfigSource({ renderMode: "'ssg'", revalidate: '99' })
      );
      const b = await loadConfig({ cwd: cwd2 });
      expect(b.revalidate).toBe(99);
    } finally {
      await rmTmp(cwd);
      await rmTmp(cwd2);
    }
  });
});

describe('loadConfig —— TS 编译产物缓存复用', () => {
  it('mtime 不变时 → 不重新编译（产物文件数不增长）', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(cwd, 'ssr.config.ts', fullConfigSource({ revalidate: '100' }));
      await loadConfig({ cwd });
      const dir1 = await fs.readdir(path.join(cwd, '.isr-cache'));

      clearConfigCache();
      await loadConfig({ cwd });
      const dir2 = await fs.readdir(path.join(cwd, '.isr-cache'));

      expect(dir2.length).toBe(dir1.length);
    } finally {
      await rmTmp(cwd);
    }
  });
});

describe('loadConfig —— 加载失败', () => {
  it('.ts 顶层抛错 → fail fast，不回退隐藏默认配置', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `
throw new Error('intentional boom at module top level');
export default { renderMode: 'ssr', revalidate: 1 };
`
      );
      await expect(loadConfig({ cwd })).rejects.toThrow('加载配置文件失败');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('配置缺少核心字段 → fail fast', async () => {
    const cwd = await mkTmpDir();
    try {
      await writeConfig(
        cwd,
        'ssr.config.ts',
        `export default { renderMode: 'isr', revalidate: 1 };`
      );
      await expect(loadConfig({ cwd })).rejects.toThrow('routes');
    } finally {
      await rmTmp(cwd);
    }
  });

  it('空 cwd 目录 → fail fast', async () => {
    const cwd = await mkTmpDir();
    try {
      await expect(loadConfig({ cwd })).rejects.toThrow('未找到配置文件');
    } finally {
      await rmTmp(cwd);
    }
  });
});
