/**
 * 迁移扫描器 —— 检测当前项目从其他框架迁来的常见模式 + 给出 isr-engine 对应方案
 *
 * 不自动改代码（避免无声覆盖用户文件）；只报告 + 给出具体修复指令。
 *
 * 检测项：
 *   - Next.js: getStaticProps / getServerSideProps / next/image / next/font / pages 路由
 *   - Vite: 已有 vite.config.ts 但未挂 createIsrPlugin
 *   - 缺失的关键文件 / 常见配置错误
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { logger } from '@/logger';

interface MigrationFinding {
  level: 'error' | 'warn' | 'info';
  file: string;
  line?: number;
  pattern: string;
  message: string;
  fix: string;
}

export async function runMigrate(opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const findings: MigrationFinding[] = [];

  await scanForNextJs(cwd, findings);
  await scanForViteConfig(cwd, findings);
  await scanForRequiredFiles(cwd, findings);
  await scanForLegacyEntries(cwd, findings);

  // 报告
  console.log(`\n=== isr-engine migrate scan: ${cwd} ===\n`);
  if (findings.length === 0) {
    console.log('  ✓ 未发现迁移问题，可以直接 pnpm dev / pnpm build / pnpm start\n');
    return;
  }

  const byLevel = { error: 0, warn: 0, info: 0 };
  for (const f of findings) {
    const icon = f.level === 'error' ? '✗' : f.level === 'warn' ? '⚠' : 'ℹ';
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`  ${icon} [${f.level.toUpperCase()}] ${loc}`);
    console.log(`     pattern : ${f.pattern}`);
    console.log(`     why     : ${f.message}`);
    console.log(`     fix     : ${f.fix}\n`);
    byLevel[f.level]++;
  }
  console.log(
    `总计 ${findings.length} 项: ${byLevel.error} error / ${byLevel.warn} warn / ${byLevel.info} info\n`
  );

  if (byLevel.error > 0) {
    logger.error('[migrate]', `${byLevel.error} 个 error 必须修复`);
    process.exitCode = 1;
  }
}

// ─── 扫描器 ───

async function scanForNextJs(cwd: string, findings: MigrationFinding[]): Promise<void> {
  // next.config.* 存在
  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
    if (await exists(path.join(cwd, name))) {
      findings.push({
        level: 'warn',
        file: name,
        pattern: 'next.config.*',
        message: 'Next.js config 存在 —— isr-engine 不读 next.config',
        fix: '改用 vite.config.ts + createIsrPlugin()。删除本文件，参考 README "TL;DR"',
      });
    }
  }
  // pages/ 目录
  if (await exists(path.join(cwd, 'pages'))) {
    findings.push({
      level: 'warn',
      file: 'pages/',
      pattern: 'pages/ directory',
      message: 'isr-engine 不用文件路由；用单一 src/app.tsx + URL 解析',
      fix: '把 pages/* 内容迁到 src/pages/* + 在 src/app.tsx 里写路由',
    });
  }
  // app/ 目录（Next 13+ App Router）
  if (await exists(path.join(cwd, 'app'))) {
    findings.push({
      level: 'warn',
      file: 'app/',
      pattern: 'app/ directory (Next 13+ App Router)',
      message: 'isr-engine 不用 file-based routing；不过 RSC + Server Action 完全兼容',
      fix: '把 app/page.tsx 改名 src/app.tsx；page/layout 嵌套结构改为 React 组件树',
    });
  }
  // 源码里 grep 常见 next API
  const apiPatterns: Array<{ re: RegExp; pattern: string; message: string; fix: string }> = [
    {
      re: /export\s+(?:async\s+)?function\s+getStaticProps/,
      pattern: 'getStaticProps',
      message: 'Next 静态数据获取 —— isr-engine 用 cacheTag + Server Component 直接 await fetch',
      fix: '把 props 逻辑搬进 Server Component；ISR 通过 ssr.config.ts routes + cacheTag() 控制',
    },
    {
      re: /export\s+(?:async\s+)?function\s+getServerSideProps/,
      pattern: 'getServerSideProps',
      message: 'Next 动态数据获取 —— isr-engine 用 mode: "ssr" + Server Component',
      fix: 'ssr.config.ts 把对应路由设 ssr，组件里直接 await fetch',
    },
    {
      re: /from\s+['"]next\/image['"]/,
      pattern: 'next/image',
      message: 'isr-engine 提供等价 <Image> 组件',
      fix: "import { Image } from '@novel-isr/engine/image' + 在 vite.config.ts 加 createImagePlugin()",
    },
    {
      re: /from\s+['"]next\/font/,
      pattern: 'next/font',
      message:
        'isr-engine 提供 createFontPlugin（自动 font-display: swap + preload + Google Fonts 自托管）',
      fix: "vite.config.ts 加 createFontPlugin({ google: ['Inter'] })",
    },
    {
      re: /from\s+['"]next\/link['"]/,
      pattern: 'next/link',
      message: 'isr-engine 用普通 <a>，链接预取由 IntersectionObserver 自动处理',
      fix: '把 <Link href=> 改成 <a href=>；预取自动生效',
    },
    {
      re: /from\s+['"]next\/router['"]/,
      pattern: 'next/router',
      message: 'isr-engine 用浏览器 history.pushState（已被 engine 拦截 + 触发重渲）',
      fix: '改用 window.history.pushState() 或 React Router；engine 自动捕获',
    },
  ];
  await scanFiles(cwd, ['ts', 'tsx', 'js', 'jsx'], async (file, content) => {
    for (const { re, pattern, message, fix } of apiPatterns) {
      const match = content.match(re);
      if (match && match.index !== undefined) {
        const line = content.slice(0, match.index).split('\n').length;
        findings.push({
          level: 'error',
          file: path.relative(cwd, file),
          line,
          pattern,
          message,
          fix,
        });
      }
    }
  });
}

async function scanForViteConfig(cwd: string, findings: MigrationFinding[]): Promise<void> {
  const viteCfg = await firstExisting(cwd, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
  if (!viteCfg) {
    findings.push({
      level: 'error',
      file: 'vite.config.ts',
      pattern: 'missing vite.config',
      message: 'isr-engine 必须基于 Vite',
      fix: '创建 vite.config.ts，import { createIsrPlugin } from "@novel-isr/engine"; 见 README',
    });
    return;
  }
  const content = await fs.readFile(viteCfg, 'utf8');
  if (!content.includes('createIsrPlugin')) {
    findings.push({
      level: 'error',
      file: path.relative(cwd, viteCfg),
      pattern: 'createIsrPlugin not found',
      message: 'vite.config 没挂 createIsrPlugin —— ISR/SSG/RSC 都不会工作',
      fix: 'plugins: [...createIsrPlugin()]（spread 因为返回数组）',
    });
  }
  if (content.includes('@vitejs/plugin-react') && !content.includes('// engine: react plugin')) {
    findings.push({
      level: 'warn',
      file: path.relative(cwd, viteCfg),
      pattern: '@vitejs/plugin-react',
      message: '@vitejs/plugin-rsc 内置 react-refresh，重复挂会报 RefreshRuntime 已声明',
      fix: '删除 @vitejs/plugin-react —— createIsrPlugin 内部已配 react',
    });
  }
}

async function scanForRequiredFiles(cwd: string, findings: MigrationFinding[]): Promise<void> {
  const appCandidates = ['src/app.tsx', 'src/App.tsx', 'src/root.tsx', 'src/Root.tsx'];
  const found = await firstExisting(cwd, appCandidates);
  if (!found) {
    findings.push({
      level: 'error',
      file: 'src/app.tsx',
      pattern: 'missing app entry',
      message: '需要一个 export App({url}) 的根组件',
      fix: '创建 src/app.tsx，参考 README "TL;DR" 的最小例子',
    });
  }
}

async function scanForLegacyEntries(cwd: string, findings: MigrationFinding[]): Promise<void> {
  for (const f of ['_app.tsx', '_document.tsx', '_app.jsx', '_document.jsx']) {
    if (await exists(path.join(cwd, 'pages', f))) {
      findings.push({
        level: 'warn',
        file: `pages/${f}`,
        pattern: 'Next _app/_document',
        message: 'isr-engine 不用 _app/_document —— shell HTML 在 src/app.tsx 里直接写',
        fix: '把 _app 的全局 Provider 包到 src/app.tsx 的根；_document 的 <head> 移到 src/app.tsx 的 <head>',
      });
    }
  }
}

// ─── 工具 ───

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(cwd: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    const p = path.join(cwd, n);
    if (await exists(p)) return p;
  }
  return null;
}

async function scanFiles(
  cwd: string,
  extensions: string[],
  fn: (file: string, content: string) => Promise<void>
): Promise<void> {
  const skip = new Set(['node_modules', 'dist', '.git', '.next', 'coverage']);
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (extensions.some(ext => ent.name.endsWith('.' + ext))) {
        try {
          const content = await fs.readFile(full, 'utf8');
          await fn(full, content);
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(cwd);
}
