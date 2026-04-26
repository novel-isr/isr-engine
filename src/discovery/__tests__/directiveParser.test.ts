/**
 * directiveParser —— TS Compiler API 解析 'use client' / 'use server' / 'use cache'
 *
 * 这是 RSC 边界识别的核心：每个组件能否在 server 渲染、能否被客户端 import，
 * 都由这里判断。错一个分支就可能让 server-only 代码被打进 client bundle，
 * 或反之 —— 是高敏感度逻辑，必须有测试。
 *
 * 范围：parseDirective / analyzeDirectives / 冲突检测 / 禁止导出 / 特殊文件检测
 */
import { describe, it, expect } from 'vitest';
import {
  parseDirective,
  analyzeDirectives,
  validateDirectives,
  hasDirectiveConflict,
  parseComponentType,
  isClientComponent,
  isServerComponent,
  hasClientDirective,
  hasServerDirective,
  hasCacheDirective,
  checkForbiddenExports,
  requiresClientDirective,
  checkClientRequiredFile,
  validateFile,
  formatDirectiveErrors,
  getComponentTypeFromDirective,
  FORBIDDEN_CLIENT_EXPORTS,
} from '../directiveParser';

describe('parseDirective —— 基本指令识别', () => {
  it("'use client' 在文件顶部 → 识别", () => {
    const r = parseDirective(`'use client';\nimport React from 'react';`);
    expect(r.directive).toBe('use client');
    expect(r.isValidPosition).toBe(true);
    expect(r.line).toBe(0);
  });

  it("'use server' 在文件顶部 → 识别", () => {
    const r = parseDirective(`'use server';\nexport async function action() {}`);
    expect(r.directive).toBe('use server');
    expect(r.isValidPosition).toBe(true);
  });

  it("'use cache' （React 19）→ 识别", () => {
    const r = parseDirective(`'use cache';\nexport async function getData() {}`);
    expect(r.directive).toBe('use cache');
  });

  it('无指令 → null', () => {
    expect(parseDirective(`import x from 'y';`).directive).toBeNull();
    expect(parseDirective(``).directive).toBeNull();
    expect(parseDirective(`function foo() {}`).directive).toBeNull();
  });

  it('指令必须在文件顶部 —— import 之后的指令无效', () => {
    const r = parseDirective(`import x from 'y';\n'use client';`);
    expect(r.directive).toBeNull();
    expect(r.isValidPosition).toBe(false);
  });

  it('双引号也支持', () => {
    const r = parseDirective(`"use client";\nfunction X() {}`);
    expect(r.directive).toBe('use client');
  });

  it('类型声明在指令前不影响识别（type/interface 是声明时不执行）', () => {
    const r = parseDirective(`type Foo = string;\ninterface Bar {}\n'use client';`);
    expect(r.directive).toBe('use client');
  });
});

describe('analyzeDirectives —— 错误检测', () => {
  it("括号包裹 ('use client') → PARENTHESIZED 错误", () => {
    const a = analyzeDirectives(`('use client');`);
    expect(a.directive).toBeNull();
    expect(a.errors.some(e => e.code === 'PARENTHESIZED')).toBe(true);
  });

  it("'use client' + 'use server' 同时存在 → CONFLICT", () => {
    const a = analyzeDirectives(`'use client';\n'use server';`);
    expect(a.errors.some(e => e.code === 'CONFLICT')).toBe(true);
  });

  it("'use client' + 'use cache' 冲突 → CONFLICT_CACHE", () => {
    const a = analyzeDirectives(`'use client';\n'use cache';`);
    expect(a.errors.some(e => e.code === 'CONFLICT_CACHE')).toBe(true);
  });

  it('重复 use client → DUPLICATE', () => {
    const a = analyzeDirectives(`'use client';\n'use client';`);
    expect(a.errors.some(e => e.code === 'DUPLICATE')).toBe(true);
  });

  it("拼写错误的指令 'use clinet' → UNKNOWN_DIRECTIVE", () => {
    const a = analyzeDirectives(`'use clinet';`);
    expect(a.errors.some(e => e.code === 'UNKNOWN_DIRECTIVE')).toBe(true);
  });

  it('非 use 开头的字符串字面量不报 UNKNOWN（避免业务字符串误报）', () => {
    const a = analyzeDirectives(`'just a string';`);
    expect(a.errors.length).toBe(0);
  });

  it('指令在 import 之后 → INVALID_POSITION', () => {
    const a = analyzeDirectives(`import x from 'y';\n'use client';`);
    expect(a.errors.some(e => e.code === 'INVALID_POSITION')).toBe(true);
  });

  it('hasDirectiveConflict 检测', () => {
    expect(hasDirectiveConflict(`'use client';\n'use server';`)).toBe(true);
    expect(hasDirectiveConflict(`'use client';`)).toBe(false);
  });
});

describe('parseComponentType —— 默认 server', () => {
  it("'use client' → client", () => {
    expect(parseComponentType(`'use client';`)).toBe('client');
  });

  it('无指令 → server（RSC 默认）', () => {
    expect(parseComponentType(`function X() {}`)).toBe('server');
  });

  it("'use server' → server（Server Action 也归 server）", () => {
    expect(parseComponentType(`'use server';`)).toBe('server');
  });

  it('isClientComponent / isServerComponent 互斥', () => {
    expect(isClientComponent(`'use client';`)).toBe(true);
    expect(isServerComponent(`'use client';`)).toBe(false);
    expect(isClientComponent(``)).toBe(false);
    expect(isServerComponent(``)).toBe(true);
  });

  it('hasClientDirective / hasServerDirective / hasCacheDirective', () => {
    expect(hasClientDirective(`'use client';`)).toBe(true);
    expect(hasServerDirective(`'use server';`)).toBe(true);
    expect(hasCacheDirective(`'use cache';`)).toBe(true);
    expect(hasClientDirective(``)).toBe(false);
  });
});

describe('checkForbiddenExports —— Client Component 禁止 server-only export', () => {
  it("'use client' + export const metadata → 报违规", () => {
    const v = checkForbiddenExports(`'use client';\nexport const metadata = { title: 'X' };`);
    expect(v.length).toBe(1);
    expect(v[0].exportName).toBe('metadata');
  });

  it('export function generateMetadata → 报违规', () => {
    const v = checkForbiddenExports(
      `'use client';\nexport function generateMetadata() { return {}; }`
    );
    expect(v.length).toBe(1);
    expect(v[0].exportName).toBe('generateMetadata');
  });

  it('export { metadata } 命名导出 → 报违规', () => {
    const v = checkForbiddenExports(`'use client';\nconst metadata = {};\nexport { metadata };`);
    expect(v.length).toBe(1);
  });

  it('Route Handler 名（GET/POST/...）也禁止', () => {
    const code = `'use client';
export const GET = () => {};
export const POST = () => {};`;
    const v = checkForbiddenExports(code);
    expect(v.map(x => x.exportName).sort()).toEqual(['GET', 'POST']);
  });

  it('非 Client Component → 不检查（无违规）', () => {
    const v = checkForbiddenExports(`export const metadata = {};`);
    expect(v).toEqual([]);
  });

  it('FORBIDDEN_CLIENT_EXPORTS 包含核心 Server-only 名', () => {
    expect(FORBIDDEN_CLIENT_EXPORTS.has('metadata')).toBe(true);
    expect(FORBIDDEN_CLIENT_EXPORTS.has('generateMetadata')).toBe(true);
    expect(FORBIDDEN_CLIENT_EXPORTS.has('revalidate')).toBe(true);
    expect(FORBIDDEN_CLIENT_EXPORTS.has('GET')).toBe(true);
    // 非 server-only 不在内
    expect(FORBIDDEN_CLIENT_EXPORTS.has('default')).toBe(false);
  });
});

describe('requiresClientDirective —— 特殊文件名约定', () => {
  it('error.tsx / loading.tsx / not-found.tsx / template.tsx / global-error.tsx 必须 use client', () => {
    expect(requiresClientDirective('src/error.tsx')).toBe('error');
    expect(requiresClientDirective('src/loading.tsx')).toBe('loading');
    expect(requiresClientDirective('src/not-found.tsx')).toBe('not-found');
    expect(requiresClientDirective('src/template.tsx')).toBe('template');
    expect(requiresClientDirective('src/global-error.tsx')).toBe('global-error');
  });

  it('普通文件不强制', () => {
    expect(requiresClientDirective('src/page.tsx')).toBeNull();
    expect(requiresClientDirective('src/component.tsx')).toBeNull();
  });

  it('checkClientRequiredFile —— error.tsx 缺 use client → MISSING_CLIENT_DIRECTIVE', () => {
    const err = checkClientRequiredFile(`export default () => null;`, 'src/error.tsx');
    expect(err?.code).toBe('MISSING_CLIENT_DIRECTIVE');
  });

  it('error.tsx 已有 use client → 无错误', () => {
    const err = checkClientRequiredFile(
      `'use client';\nexport default () => null;`,
      'src/error.tsx'
    );
    expect(err).toBeNull();
  });

  it('普通文件无 use client → 不报 MISSING（不强制）', () => {
    expect(checkClientRequiredFile(`export default () => null;`, 'src/page.tsx')).toBeNull();
  });
});

describe('validateFile —— 端到端校验', () => {
  it('error.tsx 缺 use client + Client Component 导出 metadata → 多个错误', () => {
    const errors = validateFile(
      `export const metadata = { title: 'X' };\nexport default () => null;`,
      'src/error.tsx'
    );
    expect(errors.some(e => e.code === 'MISSING_CLIENT_DIRECTIVE')).toBe(true);
  });

  it('正常 use client 组件 → 无错误', () => {
    const errors = validateFile(
      `'use client';\nimport { useState } from 'react';\nexport default () => null;`,
      'src/Button.tsx'
    );
    expect(errors).toEqual([]);
  });
});

describe('formatDirectiveErrors —— 错误格式化', () => {
  it('空错误 → 空串', () => {
    expect(formatDirectiveErrors([])).toBe('');
  });

  it('包含错误代码 + 行号（1-based） + suggestion', () => {
    const errors = validateDirectives(`'use client';\n'use server';`);
    const formatted = formatDirectiveErrors(errors);
    expect(formatted).toMatch(/CONFLICT/);
    // 1-based 行号 —— 第二个指令在第 1 行（0-indexed），格式化时显示第 2 行
    expect(formatted).toMatch(/第 2 行/);
  });
});

describe('getComponentTypeFromDirective —— 从分析结果导出类型', () => {
  it("directive='use client' + valid → client", () => {
    expect(
      getComponentTypeFromDirective({ directive: 'use client', line: 0, isValidPosition: true })
    ).toBe('client');
  });

  it("directive='use client' 但 invalidPosition → server（位置不对就当无指令）", () => {
    expect(
      getComponentTypeFromDirective({ directive: 'use client', line: 5, isValidPosition: false })
    ).toBe('server');
  });

  it("directive='use server' → server（Server Action 也是 server）", () => {
    expect(
      getComponentTypeFromDirective({ directive: 'use server', line: 0, isValidPosition: true })
    ).toBe('server');
  });
});
