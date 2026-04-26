/**
 * scan —— 项目目录扫描器（plugin-rsc 模式下的轻量发现）
 *
 * 测试策略：临时目录 + 控制 pages/api/components 子目录的存在与否，
 * 验证 scanProject / scanRoutes / scanComponents 三个 API。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanProject, scanRoutes, scanComponents, DEFAULT_SCAN_CONFIG } from '../scan';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content = ''): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

describe('scanProject —— 完整项目扫描', () => {
  it('空项目目录 → 0 routes 0 components', async () => {
    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(0);
    expect(r.routes.apis.length).toBe(0);
    expect(r.components.length).toBe(0);
    expect(r.scanTime).toBeGreaterThanOrEqual(0);
  });

  it('pages/api/components 都存在 → 计数正确', async () => {
    await write('src/pages/index.tsx', 'export default () => null;');
    await write('src/pages/about.tsx', 'export default () => null;');
    await write('src/api/health.ts', 'export const GET = () => new Response("ok");');
    await write('src/components/Button.tsx', `'use client';\nexport default () => null;`);
    await write('src/components/Header.tsx', 'export default () => null;');

    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(2);
    expect(r.routes.apis.length).toBe(1);
    expect(r.components.length).toBeGreaterThanOrEqual(2);
  });

  it('test 文件 (.test.tsx) 不计入', async () => {
    await write('src/pages/index.tsx', 'export default () => null;');
    await write('src/pages/index.test.tsx', 'test("x", () => {});');
    await write('src/pages/about.spec.tsx', 'test("x", () => {});');

    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(1);
  });

  it('非代码文件（.md / .json / .css）不计入', async () => {
    await write('src/pages/index.tsx', 'export default () => null;');
    await write('src/pages/README.md', '# docs');
    await write('src/pages/style.css', 'body{}');
    await write('src/pages/data.json', '{}');

    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(1);
  });

  it('目录不存在 → 静默跳过（不抛错）', async () => {
    // 只创建 pages，不建 api 和 components
    await write('src/pages/index.tsx', 'export default () => null;');
    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(1);
    expect(r.routes.apis.length).toBe(0);
    expect(r.components.length).toBe(0);
  });

  it('enableApiRoutes=false → 跳过 API 扫描', async () => {
    await write('src/api/health.ts', 'export const GET = () => null;');
    const r = await scanProject(dir, { enableApiRoutes: false });
    expect(r.routes.apis.length).toBe(0);
  });

  it('scanComponents=false → 跳过组件扫描', async () => {
    await write('src/components/Button.tsx', 'export default () => null;');
    const r = await scanProject(dir, { scanComponents: false });
    expect(r.components.length).toBe(0);
  });

  it('自定义 componentDirs → 多目录组合扫描', async () => {
    await write('src/components/A.tsx', 'export default () => null;');
    await write('src/widgets/B.tsx', 'export default () => null;');
    const r = await scanProject(dir, { componentDirs: ['src/components', 'src/widgets'] });
    expect(r.components.length).toBe(2);
  });

  it('递归扫描子目录', async () => {
    await write('src/pages/index.tsx', 'export default () => null;');
    await write('src/pages/blog/post-1.tsx', 'export default () => null;');
    await write('src/pages/blog/2024/post-2.tsx', 'export default () => null;');
    const r = await scanProject(dir);
    expect(r.routes.pages.length).toBe(3);
  });
});

describe('scanRoutes —— 仅扫路由（不解析组件）', () => {
  it('返回 pages + apis 两类', async () => {
    await write('src/pages/index.tsx', 'export default () => null;');
    await write('src/api/x.ts', 'export const GET = () => null;');
    const r = await scanRoutes(dir);
    expect(r.pages.length).toBe(1);
    expect(r.apis.length).toBe(1);
  });

  it('enableApiRoutes=false → apis=[]', async () => {
    await write('src/api/x.ts', 'export const GET = () => null;');
    const r = await scanRoutes(dir, { enableApiRoutes: false });
    expect(r.apis.length).toBe(0);
  });

  it('自定义 pagesDir 和 apiDir', async () => {
    await write('app/routes/index.tsx', 'export default () => null;');
    await write('routes/api/x.ts', 'export const GET = () => null;');
    const r = await scanRoutes(dir, { pagesDir: 'app/routes', apiDir: 'routes/api' });
    expect(r.pages.length).toBe(1);
    expect(r.apis.length).toBe(1);
  });
});

describe('scanComponents —— 仅扫组件 + 解析指令', () => {
  it('"use client" 指令被识别为 client component', async () => {
    await write(
      'src/components/Modal.tsx',
      `'use client';\nimport { useState } from 'react';\nexport default () => null;`
    );
    const components = await scanComponents(dir);
    expect(components.length).toBe(1);
    expect(components[0].type).toBe('client');
  });

  it('无指令 → server component（默认）', async () => {
    await write('src/components/Layout.tsx', `export default () => null;`);
    const components = await scanComponents(dir);
    expect(components[0].type).toBe('server');
  });

  it('多个 componentDirs', async () => {
    await write('src/components/A.tsx', 'export default () => null;');
    await write('src/ui/B.tsx', `'use client';\nexport default () => null;`);
    const components = await scanComponents(dir, ['src/components', 'src/ui']);
    expect(components.length).toBe(2);
    const types = components.map(c => c.type).sort();
    expect(types).toEqual(['client', 'server']);
  });

  it('空目录 → 空数组（不抛错）', async () => {
    const components = await scanComponents(dir);
    expect(components).toEqual([]);
  });
});

describe('DEFAULT_SCAN_CONFIG', () => {
  it('包含合理默认值', () => {
    expect(DEFAULT_SCAN_CONFIG.pagesDir).toBe('src/pages');
    expect(DEFAULT_SCAN_CONFIG.apiDir).toBe('src/api');
    expect(DEFAULT_SCAN_CONFIG.componentDirs).toEqual(['src/components']);
    expect(DEFAULT_SCAN_CONFIG.scanComponents).toBe(true);
    expect(DEFAULT_SCAN_CONFIG.enableApiRoutes).toBe(true);
    expect(DEFAULT_SCAN_CONFIG.headerOnly).toBe(true);
    expect(DEFAULT_SCAN_CONFIG.headerLines).toBe(50);
  });
});
