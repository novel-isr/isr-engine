/**
 * AST 导出解析器
 * 使用 TypeScript Compiler API 解析模块导出
 */

import ts from 'typescript';
import { createSourceFile } from './directiveParser';

/**
 * 导出类型
 */
export type ExportKind =
  | 'default' // export default
  | 'named' // export const foo
  | 'reexport' // export { foo } from './bar'
  | 'reexport-all'; // export * from './bar'

/**
 * 导出信息
 */
export interface ExportInfo {
  /** 导出名称 */
  name: string;
  /** 本地名称（如果有 as 重命名） */
  localName?: string;
  /** 导出类型 */
  kind: ExportKind;
  /** 来源模块（re-export 时有值） */
  from?: string;
  /** 是否为类型导出 */
  isType: boolean;
}

/**
 * 模块导出分析结果
 */
export interface ModuleExports {
  /** 所有导出 */
  exports: ExportInfo[];
  /** 是否有默认导出 */
  hasDefault: boolean;
  /** 命名导出列表 */
  namedExports: string[];
  /** re-export 来源模块列表 */
  reexportSources: string[];
}

/**
 * 使用 AST 解析模块导出
 */
export function parseExports(content: string): ModuleExports {
  const sourceFile = createSourceFile(content);
  const exports: ExportInfo[] = [];

  for (const statement of sourceFile.statements) {
    // export default xxx
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exports.push({
        name: 'default',
        kind: 'default',
        isType: false,
      });
      continue;
    }

    // export * from './module'
    if (ts.isExportDeclaration(statement) && !statement.exportClause) {
      const from = getModuleSpecifier(statement);
      if (from) {
        exports.push({
          name: '*',
          kind: 'reexport-all',
          from,
          isType: statement.isTypeOnly ?? false,
        });
      }
      continue;
    }

    // export { foo, bar } 或 export { foo } from './module'
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      const from = getModuleSpecifier(statement);
      const isTypeExport = statement.isTypeOnly ?? false;

      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exportedName = element.name.text;
          const localName = element.propertyName?.text;

          exports.push({
            name: exportedName,
            localName: localName !== exportedName ? localName : undefined,
            kind: from ? 'reexport' : 'named',
            from,
            isType: isTypeExport || element.isTypeOnly,
          });
        }
      }
      continue;
    }

    // export function/class/const/let/var
    if (hasExportModifier(statement)) {
      const names = getDeclarationNames(statement);
      const isDefault = hasDefaultModifier(statement);

      for (const name of names) {
        exports.push({
          name: isDefault ? 'default' : name,
          localName: isDefault ? name : undefined,
          kind: isDefault ? 'default' : 'named',
          isType: ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement),
        });
      }
    }
  }

  return {
    exports,
    hasDefault: exports.some(e => e.name === 'default'),
    namedExports: exports.filter(e => e.kind === 'named' && !e.isType).map(e => e.name),
    reexportSources: [
      ...new Set(
        exports.map(e => e.from).filter((from): from is string => typeof from === 'string')
      ),
    ],
  };
}

/**
 * 检查是否有 export 修饰符
 */
function hasExportModifier(node: ts.Statement): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * 检查是否有 default 修饰符
 */
function hasDefaultModifier(node: ts.Statement): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/**
 * 获取模块标识符
 */
function getModuleSpecifier(node: ts.ExportDeclaration): string | undefined {
  if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  return undefined;
}

/**
 * 获取声明的名称
 */
function getDeclarationNames(statement: ts.Statement): string[] {
  const names: string[] = [];

  // function foo() {} / class Foo {}
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (statement.name) {
      names.push(statement.name.text);
    }
  }

  // const foo = ..., bar = ...
  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        // 解构导出: export const { a, b } = obj
        extractBindingNames(decl.name, names);
      }
    }
  }

  // type Foo = ... / interface Foo {}
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    names.push(statement.name.text);
  }

  // enum Foo {}
  if (ts.isEnumDeclaration(statement)) {
    names.push(statement.name.text);
  }

  return names;
}

/**
 * 从解构模式中提取名称
 */
function extractBindingNames(pattern: ts.BindingPattern, names: string[]): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;

    if (ts.isIdentifier(element.name)) {
      names.push(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      extractBindingNames(element.name, names);
    }
  }
}

/**
 * 便捷接口：获取所有导出名称（过滤 type-only 导出）
 */
export function getExportNames(content: string): string[] {
  const result = parseExports(content);
  const names: string[] = [];

  for (const exp of result.exports) {
    if (!exp.isType && exp.name !== '*') {
      names.push(exp.name);
    }
  }

  return [...new Set(names)];
}
