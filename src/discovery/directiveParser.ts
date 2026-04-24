/**
 * AST 指令解析器
 * 使用 TypeScript Compiler API 解析 'use client' 和 'use server' 指令
 *
 * 设计原则：
 * 1. 默认所有组件都是 Server Component (RSC)
 * 2. 只有显式标记 'use client' 的组件才是客户端组件
 * 3. 'use server' 用于标记 Server Actions
 * 4. 纯内存 AST 解析，无文件 I/O
 *
 * 性能说明：
 * - 当前使用 TypeScript Compiler API（比 SWC 慢 10-50x）
 * - 已通过增量分析 + 缓存优化（见 incrementalAnalyzer.ts）
 * - 未来可迁移到 @swc/core 或 oxc 获得更好性能
 */

import ts from 'typescript';
import type { ComponentType } from './types';

/** 指令类型 - 支持 React 19 的 'use cache' */
export type DirectiveType = 'use client' | 'use server' | 'use cache';

/** 有效的指令集合 */
const VALID_DIRECTIVES = new Set<string>(['use client', 'use server', 'use cache']);

/** 指令错误类型 */
export type DirectiveErrorCode =
  | 'CONFLICT' // 'use client' + 'use server' 同时存在
  | 'CONFLICT_CACHE' // 'use client' + 'use cache' 同时存在
  | 'PARENTHESIZED' // 使用了括号形式 ('use client')
  | 'INVALID_POSITION' // 指令不在文件顶部
  | 'DUPLICATE' // 重复的指令
  | 'UNKNOWN_DIRECTIVE' // 未知的指令形式
  | 'FORBIDDEN_EXPORT' // Client Component 禁止导出 metadata 等
  | 'MISSING_CLIENT_DIRECTIVE'; // 特殊文件缺少 'use client' 指令

/** 指令错误信息 */
export interface DirectiveError {
  /** 错误代码 */
  code: DirectiveErrorCode;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: string;
  /** 行号（从 0 开始） */
  line: number;
  /** 列号 */
  column: number;
  /** 建议的修复方式 */
  suggestion?: string;
}

/** 检测到的指令信息 */
export interface DetectedDirective {
  /** 指令类型 */
  type: DirectiveType;
  /** 行号（从 0 开始） */
  line: number;
  /** 列号 */
  column: number;
  /** 是否有效 */
  isValid: boolean;
}

/** 完整的解析结果 */
export interface DirectiveAnalysisResult {
  /** 有效的指令（第一个有效指令） */
  directive: DirectiveType | null;
  /** 所有检测到的指令 */
  allDirectives: DetectedDirective[];
  /** 是否为有效位置 */
  isValidPosition: boolean;
  /** 行号 */
  line: number | null;
  /** 检测到的错误 */
  errors: DirectiveError[];
  /** 是否有错误 */
  hasErrors: boolean;
}

/** 兼容层解析结果（旧 API 签名） */
export interface DirectiveParseResult {
  /** 检测到的指令 */
  directive: DirectiveType | null;
  /** 指令位置（行号，从 0 开始） */
  line: number | null;
  /** 是否为有效位置（文件顶部，仅在注释之后） */
  isValidPosition: boolean;
}

/**
 * 创建 SourceFile（纯内存操作）
 *
 * 注意：ts.createSourceFile 是纯内存操作，不涉及文件系统
 */
export function createSourceFile(content: string, scriptKind?: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(
    'source.tsx',
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind ?? ts.ScriptKind.TSX
  );
}

/**
 * 完整的指令分析
 *
 * 检测规则：
 * 1. 指令必须是文件的第一个语句（import 之前）
 * 2. 指令必须是字符串字面量 'use client' 或 'use server'
 * 3. 不能同时存在 'use client' 和 'use server'
 * 4. 不能使用括号形式 ('use client')
 * 5. 指令后出现其他语句后不能再有指令
 */
export function analyzeDirectives(content: string): DirectiveAnalysisResult {
  const result: DirectiveAnalysisResult = {
    directive: null,
    allDirectives: [],
    isValidPosition: false,
    line: null,
    errors: [],
    hasErrors: false,
  };

  const sourceFile = createSourceFile(content);

  let finishedDirectives = false;
  let foundClientDirective = false;
  let foundServerDirective = false;
  let firstValidDirective: DetectedDirective | null = null;

  for (const statement of sourceFile.statements) {
    // 跳过类型声明（它们不影响指令位置）
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      continue;
    }

    const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));

    // 检查表达式语句
    if (ts.isExpressionStatement(statement)) {
      const expr = statement.expression;

      // 检查括号形式 ('use client')
      if (ts.isParenthesizedExpression(expr)) {
        const inner = expr.expression;
        if (ts.isStringLiteral(inner)) {
          const text = inner.text;
          if (text === 'use client' || text === 'use server') {
            result.errors.push({
              code: 'PARENTHESIZED',
              message: `指令不能使用括号形式`,
              details: `发现 ('${text}')，应该使用 '${text}'`,
              line: position.line,
              column: position.character,
              suggestion: `移除括号，直接使用 '${text}'`,
            });
            finishedDirectives = true;
            continue;
          }
        }
      }

      // 检查字符串字面量指令
      if (ts.isStringLiteral(expr)) {
        const text = expr.text;

        // 检查是否是有效指令
        if (VALID_DIRECTIVES.has(text)) {
          const directiveType = text as DirectiveType;

          // 检查是否在有效位置
          if (finishedDirectives) {
            result.errors.push({
              code: 'INVALID_POSITION',
              message: `指令 '${text}' 必须放在文件顶部`,
              details: `指令必须在所有其他语句（import、代码等）之前`,
              line: position.line,
              column: position.character,
              suggestion: `将 '${text}' 移动到文件的第一行`,
            });
            continue;
          }

          const detected: DetectedDirective = {
            type: directiveType,
            line: position.line,
            column: position.character,
            isValid: true,
          };
          result.allDirectives.push(detected);

          // 检查冲突
          if (directiveType === 'use client') {
            if (foundServerDirective) {
              result.errors.push({
                code: 'CONFLICT',
                message: `不能同时使用 'use client' 和 'use server'`,
                details: `一个文件只能是 Client Component 或 Server Actions，不能同时是两者`,
                line: position.line,
                column: position.character,
                suggestion: `移除其中一个指令。如果需要在客户端调用服务端函数，请使用 Server Actions`,
              });
            }
            if (foundClientDirective) {
              result.errors.push({
                code: 'DUPLICATE',
                message: `重复的 'use client' 指令`,
                line: position.line,
                column: position.character,
                suggestion: `移除重复的指令`,
              });
            }
            foundClientDirective = true;
          }

          if (directiveType === 'use server') {
            if (foundClientDirective) {
              result.errors.push({
                code: 'CONFLICT',
                message: `不能同时使用 'use client' 和 'use server'`,
                details: `一个文件只能是 Client Component 或 Server Actions，不能同时是两者`,
                line: position.line,
                column: position.character,
                suggestion: `移除其中一个指令`,
              });
            }
            if (foundServerDirective) {
              result.errors.push({
                code: 'DUPLICATE',
                message: `重复的 'use server' 指令`,
                line: position.line,
                column: position.character,
                suggestion: `移除重复的指令`,
              });
            }
            foundServerDirective = true;
          }

          // React 19 'use cache' 检测
          if (directiveType === 'use cache') {
            if (foundClientDirective) {
              result.errors.push({
                code: 'CONFLICT_CACHE',
                message: `不能同时使用 'use client' 和 'use cache'`,
                details: `'use cache' 只能用于 Server Components 或 Server Actions`,
                line: position.line,
                column: position.character,
                suggestion: `移除 'use client' 或 'use cache' 其中一个指令`,
              });
            }
            // 'use cache' 可以和 'use server' 一起使用（缓存 Server Actions）
          }

          // 记录第一个有效指令
          if (!firstValidDirective) {
            firstValidDirective = detected;
          }

          continue;
        } else if (text.startsWith('use ')) {
          // 可能是拼写错误的指令
          result.errors.push({
            code: 'UNKNOWN_DIRECTIVE',
            message: `未知的指令 '${text}'`,
            details: `只支持 'use client', 'use server' 和 'use cache'`,
            line: position.line,
            column: position.character,
            suggestion: `检查拼写，确保使用 'use client', 'use server' 或 'use cache'`,
          });
          continue;
        }
      }
    }

    // 遇到非指令语句，标记指令区域结束
    finishedDirectives = true;
  }

  // 设置结果
  if (firstValidDirective && result.errors.filter(e => e.code === 'CONFLICT').length === 0) {
    result.directive = firstValidDirective.type;
    result.line = firstValidDirective.line;
    result.isValidPosition = true;
  }

  result.hasErrors = result.errors.length > 0;

  return result;
}

/**
 * 使用 AST 解析代码中的指令（便捷接口，兼容旧 API 签名）
 *
 * 规则：
 * 1. 指令必须是文件的第一个语句（import 之前）
 * 2. 指令必须是字符串字面量表达式 'use client' 或 "use client"
 * 3. 只有 'use client' 和 'use server' 是有效指令
 */
export function parseDirective(content: string): DirectiveParseResult {
  const analysis = analyzeDirectives(content);

  return {
    directive: analysis.directive,
    line: analysis.line,
    isValidPosition: analysis.isValidPosition,
  };
}

/**
 * 验证指令并返回错误（如果有）
 */
export function validateDirectives(content: string): DirectiveError[] {
  return analyzeDirectives(content).errors;
}

/**
 * 检查指令是否有冲突
 */
export function hasDirectiveConflict(content: string): boolean {
  const errors = analyzeDirectives(content).errors;
  return errors.some(e => e.code === 'CONFLICT');
}

/**
 * 从指令确定组件类型
 *
 * 规则：
 * - 'use client' → client
 * - 'use server' → server (Server Actions)
 * - 无指令 → server (默认 RSC)
 */
export function getComponentTypeFromDirective(result: DirectiveParseResult): ComponentType {
  if (result.directive === 'use client' && result.isValidPosition) {
    return 'client';
  }
  // 默认是 Server Component
  return 'server';
}

/**
 * 解析组件类型（便捷接口）
 *
 * @param content - 源代码
 * @returns 'client' | 'server'，默认为 'server'
 */
export function parseComponentType(content: string): ComponentType {
  const directiveResult = parseDirective(content);
  return getComponentTypeFromDirective(directiveResult);
}

/**
 * 检查是否为客户端组件
 */
export function isClientComponent(content: string): boolean {
  return parseComponentType(content) === 'client';
}

/**
 * 检查是否为服务端组件
 */
export function isServerComponent(content: string): boolean {
  return parseComponentType(content) === 'server';
}

/**
 * 检查是否有 'use client' 指令
 */
export function hasClientDirective(content: string): boolean {
  const result = parseDirective(content);
  return result.directive === 'use client' && result.isValidPosition;
}

/**
 * 检查是否有 'use server' 指令（Server Actions）
 */
export function hasServerDirective(content: string): boolean {
  const result = parseDirective(content);
  return result.directive === 'use server' && result.isValidPosition;
}

/**
 * 检查是否有 'use cache' 指令（React 19 缓存）
 */
export function hasCacheDirective(content: string): boolean {
  const result = parseDirective(content);
  return result.directive === 'use cache' && result.isValidPosition;
}

/**
 * 格式化指令错误为可读消息
 */
export function formatDirectiveErrors(errors: DirectiveError[]): string {
  if (errors.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push(`发现 ${errors.length} 个指令错误:\n`);

  for (const error of errors) {
    lines.push(`  ✗ [${error.code}] 第 ${error.line + 1} 行: ${error.message}`);
    if (error.details) {
      lines.push(`    ${error.details}`);
    }
    if (error.suggestion) {
      lines.push(`    → 建议: ${error.suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Client Component 禁止导出的 Server-only 标识符
 * （这些 export 名只在服务端组件里才有意义，标了 'use client' 时应当报错）
 */
export const FORBIDDEN_CLIENT_EXPORTS = new Set<string>([
  // Metadata
  'metadata',
  'generateMetadata',
  'generateViewport',
  'viewport',
  // Static Generation
  'generateStaticParams',
  // Sitemap/Robots
  'generateSitemaps',
  'generateRobots',
  // Route Handlers (App Router)
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  // Dynamic & Revalidation
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
]);

/** Metadata 导出违规信息 */
export interface ForbiddenExportViolation {
  /** 禁止的导出名称 */
  exportName: string;
  /** 行号 */
  line: number;
  /** 列号 */
  column: number;
  /** 原因说明 */
  reason: string;
}

/**
 * 检查 Client Component 是否包含禁止的导出
 *
 * 规则：
 * - Client Component ('use client') 不能导出 metadata、generateMetadata 等
 * - 这些 API 只能在 Server Components 中使用
 *
 * @param content - 源代码
 * @returns 违规信息列表
 */
export function checkForbiddenExports(content: string): ForbiddenExportViolation[] {
  const violations: ForbiddenExportViolation[] = [];

  // 首先检查是否是 Client Component
  const directiveResult = parseDirective(content);
  if (directiveResult.directive !== 'use client' || !directiveResult.isValidPosition) {
    // 不是 Client Component，无需检查
    return violations;
  }

  const sourceFile = createSourceFile(content);

  for (const statement of sourceFile.statements) {
    // 检查导出声明: export const metadata = ...
    if (ts.isVariableStatement(statement)) {
      const isExported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const name = declaration.name.text;
            if (FORBIDDEN_CLIENT_EXPORTS.has(name)) {
              const position = sourceFile.getLineAndCharacterOfPosition(
                declaration.name.getStart(sourceFile)
              );
              violations.push({
                exportName: name,
                line: position.line,
                column: position.character,
                reason: `'${name}' 只能在 Server Components 中导出`,
              });
            }
          }
        }
      }
    }

    // 检查导出函数声明: export function generateMetadata() {}
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const isExported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        const name = statement.name.text;
        if (FORBIDDEN_CLIENT_EXPORTS.has(name)) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            statement.name.getStart(sourceFile)
          );
          violations.push({
            exportName: name,
            line: position.line,
            column: position.character,
            reason: `'${name}' 是 Server-only 的函数，不能在 Client Components 中导出`,
          });
        }
      }
    }

    // 检查导出声明: export { metadata } 或 export { generateMetadata }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exportedName = (element.propertyName || element.name).text;
          if (FORBIDDEN_CLIENT_EXPORTS.has(exportedName)) {
            const position = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            violations.push({
              exportName: exportedName,
              line: position.line,
              column: position.character,
              reason: `'${exportedName}' 只能在 Server Components 中导出`,
            });
          }
        }
      }
    }

    // 检查默认导出带名称的情况（通常不会碰到，但以防万一）
    // export default function generateMetadata() {}
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const isDefaultExport = statement.modifiers?.some(
        m => m.kind === ts.SyntaxKind.DefaultKeyword
      );
      if (isDefaultExport) {
        const name = statement.name.text;
        if (FORBIDDEN_CLIENT_EXPORTS.has(name)) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            statement.name.getStart(sourceFile)
          );
          violations.push({
            exportName: name,
            line: position.line,
            column: position.character,
            reason: `'${name}' 是 Server-only 的函数，不能作为默认导出在 Client Components 中使用`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * 必须是 Client Component 的特殊文件名（约定）
 *
 * - error.tsx:        错误边界必须是 client component（React 限制）
 * - global-error.tsx: 全局错误边界
 * - loading.tsx:      Loading UI 使用 Suspense fallback
 * - not-found.tsx:    404 页面通常需要客户端交互
 * - template.tsx:     模板文件需要客户端状态
 */
const CLIENT_REQUIRED_FILES = new Set([
  'error',
  'global-error',
  'loading',
  'not-found',
  'template',
]);

/**
 * 从文件路径提取基础文件名（不含扩展名）
 */
function extractBaseName(filePath: string): string {
  const fileName = filePath.split('/').pop() || filePath;
  // 移除扩展名 (.tsx, .ts, .jsx, .js)
  return fileName.replace(/\.(tsx?|jsx?)$/, '');
}

/**
 * 检查文件是否需要强制 'use client'
 *
 * @param filePath 文件路径
 * @returns 如果需要强制 'use client'，返回文件类型描述
 */
export function requiresClientDirective(filePath: string): string | null {
  const baseName = extractBaseName(filePath);
  if (CLIENT_REQUIRED_FILES.has(baseName)) {
    return baseName;
  }
  return null;
}

/**
 * 检查特殊文件是否缺少 'use client' 指令
 *
 * @param content 文件内容
 * @param filePath 文件路径
 * @returns 如果缺少必要的 'use client' 指令，返回错误
 */
export function checkClientRequiredFile(content: string, filePath: string): DirectiveError | null {
  const fileType = requiresClientDirective(filePath);
  if (!fileType) {
    return null;
  }

  // 检查是否有 'use client' 指令
  const result = parseDirective(content);
  if (result.directive !== 'use client') {
    return {
      code: 'MISSING_CLIENT_DIRECTIVE' as DirectiveErrorCode,
      message: `${fileType}.tsx 必须是 Client Component`,
      details: `文件 ${fileType}.tsx 需要添加 'use client' 指令才能正常工作`,
      line: 1,
      column: 1,
      suggestion: `在文件顶部添加 'use client' 指令`,
    };
  }

  return null;
}

/**
 * 完整验证：指令 + 禁止导出检查 + 特殊文件检查
 *
 * 同时检查：
 * 1. 指令错误（位置、冲突等）
 * 2. Client Component 中的禁止导出
 * 3. 特殊文件必须是 Client Component
 */
export function validateFile(content: string, filePath?: string): DirectiveError[] {
  const errors = validateDirectives(content);

  // 检查禁止导出
  const violations = checkForbiddenExports(content);
  for (const violation of violations) {
    errors.push({
      code: 'FORBIDDEN_EXPORT',
      message: `Client Component 禁止导出 '${violation.exportName}'`,
      details: violation.reason,
      line: violation.line,
      column: violation.column,
      suggestion: `移除此导出，或将组件改为 Server Component（移除 'use client' 指令）`,
    });
  }

  // 检查特殊文件
  if (filePath) {
    const clientRequiredError = checkClientRequiredFile(content, filePath);
    if (clientRequiredError) {
      errors.push(clientRequiredError);
    }
  }

  return errors;
}
