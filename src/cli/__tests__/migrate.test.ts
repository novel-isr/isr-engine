/**
 * CLI migrate —— 扫描 Next.js / 老 Vite 配置，给出迁移建议
 *
 * 测试策略：构造临时项目目录，跑 runMigrate，断言 findings（通过截取 console.log）。
 * 所有扫描器都是纯函数 + fs 读取，不依赖网络或外部进程，测试易于稳定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrate } from '../migrate';

async function mkTmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 捕获 runMigrate 输出的 console.log 以断言 findings */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
      console.log = origLog;
    },
  };
}

describe('runMigrate —— Next.js 模式检测', () => {
  let dir: string;
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    cap = captureLogs();
    // 清除可能被上次测试设的 exit code
    process.exitCode = 0;
  });
  afterEach(async () => {
    cap.restore();
    if (dir) await rmTmp(dir);
    process.exitCode = 0;
  });

  it('检测 next.config.ts 存在 → warn', async () => {
    dir = await mkTmpProject({
      'next.config.ts': 'export default {}',
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/next\.config\.ts/);
    expect(output).toMatch(/\[WARN\]/);
    expect(output).toMatch(/pattern\s*:\s*next\.config/);
  });

  it('检测 pages/ 目录 → warn', async () => {
    dir = await mkTmpProject({
      'pages/index.tsx': 'export default () => null;',
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/pages\/ directory/);
  });

  it('检测 app/ 目录（Next 13+ App Router）→ warn', async () => {
    dir = await mkTmpProject({
      'app/page.tsx': 'export default () => null;',
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/App Router/);
  });

  it('源码中 getStaticProps → error + 精确行号', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
      'src/pages/home.tsx': [
        'import React from "react";',
        'export default function Home() { return null; }',
        '',
        'export async function getStaticProps() { return { props: {} }; }',
      ].join('\n'),
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/\[ERROR\]/);
    expect(output).toMatch(/getStaticProps/);
    // 行号应为 4（getStaticProps 所在行）
    expect(output).toMatch(/home\.tsx:4/);
    expect(process.exitCode).toBe(1);
  });

  it('源码中 next/image import → error', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
      'src/Header.tsx': 'import Image from "next/image";\nexport default () => null;',
    });
    await runMigrate({ cwd: dir });
    expect(cap.lines.join('\n')).toMatch(/next\/image/);
    expect(process.exitCode).toBe(1);
  });

  it('node_modules / dist / .git 被扫描器跳过（防止误报第三方 next/link 引用）', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
      // 这个文件若被扫到会触发 next/link error
      'node_modules/foo/index.tsx': 'import Link from "next/link";',
      'dist/chunk.js': 'import "next/router";',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).not.toMatch(/next\/link/);
    expect(output).not.toMatch(/next\/router/);
  });
});

describe('runMigrate —— Vite 配置检测', () => {
  let dir: string;
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    cap = captureLogs();
    process.exitCode = 0;
  });
  afterEach(async () => {
    cap.restore();
    if (dir) await rmTmp(dir);
    process.exitCode = 0;
  });

  it('缺 vite.config → error', async () => {
    dir = await mkTmpProject({ 'src/app.tsx': 'export default () => null;' });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/missing vite\.config/);
    expect(process.exitCode).toBe(1);
  });

  it('vite.config 没挂 createIsrPlugin → error', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'export default { plugins: [] };',
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    expect(cap.lines.join('\n')).toMatch(/createIsrPlugin not found/);
  });

  it('同时挂 createIsrPlugin + @vitejs/plugin-react → warn 冲突', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': [
        'import react from "@vitejs/plugin-react";',
        'import { createIsrPlugin } from "@novel-isr/engine";',
        'export default { plugins: [react(), ...createIsrPlugin()] };',
      ].join('\n'),
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/@vitejs\/plugin-react/);
    expect(output).toMatch(/\[WARN\]/);
  });

  it('用户用 `// engine: react plugin` 注释标记豁免 → 不再报 warn', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': [
        '// engine: react plugin —— 故意保留',
        'import react from "@vitejs/plugin-react";',
        'import { createIsrPlugin } from "@novel-isr/engine";',
        'export default { plugins: [react(), ...createIsrPlugin()] };',
      ].join('\n'),
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).not.toMatch(/@vitejs\/plugin-react/);
  });
});

describe('runMigrate —— 必需文件检测', () => {
  let dir: string;
  let cap: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    cap = captureLogs();
    process.exitCode = 0;
  });
  afterEach(async () => {
    cap.restore();
    if (dir) await rmTmp(dir);
    process.exitCode = 0;
  });

  it('缺 src/app.tsx 及所有候选 → error', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
    });
    await runMigrate({ cwd: dir });
    expect(cap.lines.join('\n')).toMatch(/missing app entry/);
    expect(process.exitCode).toBe(1);
  });

  it('存在 src/App.tsx（大写） → 识别', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/App.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    expect(cap.lines.join('\n')).not.toMatch(/missing app entry/);
  });
});

describe('runMigrate —— 无问题情况', () => {
  let dir: string;
  let cap: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    cap = captureLogs();
    process.exitCode = 0;
  });
  afterEach(async () => {
    cap.restore();
    if (dir) await rmTmp(dir);
    process.exitCode = 0;
  });

  it('干净项目 → 输出 "未发现迁移问题"，exitCode 保持 0', async () => {
    dir = await mkTmpProject({
      'vite.config.ts': 'import { createIsrPlugin } from "@novel-isr/engine"; export default {};',
      'src/app.tsx': 'export default () => null;',
    });
    await runMigrate({ cwd: dir });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/未发现迁移问题/);
    expect(process.exitCode).toBe(0);
  });
});
