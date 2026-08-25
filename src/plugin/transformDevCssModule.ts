import ts from 'typescript';
import type { TransformResult } from 'vite';

const STYLESHEET_URL = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:[?#]|$)/i;

function hasDirectQuery(value: string): boolean {
  const queryStart = value.indexOf('?');
  if (queryStart === -1) return false;
  const hashStart = value.indexOf('#', queryStart);
  return new URLSearchParams(
    value.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart)
  ).has('direct');
}

function isViteClientImport(node: ts.ImportDeclaration): node is ts.ImportDeclaration & {
  importClause: ts.ImportClause & { namedBindings: ts.NamedImports };
} {
  return (
    ts.isStringLiteral(node.moduleSpecifier) &&
    node.moduleSpecifier.text === '/@vite/client' &&
    node.importClause !== undefined &&
    node.importClause.namedBindings !== undefined &&
    ts.isNamedImports(node.importClause.namedBindings)
  );
}

function isCallToBinding(node: ts.Node, binding: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === binding
  );
}

function isImportMetaHot(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'hot' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

function findPruneCall(
  statement: ts.Statement,
  removeStyleBinding: string
): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
    return undefined;

  const prune = statement.expression;
  if (
    !ts.isPropertyAccessExpression(prune.expression) ||
    prune.expression.name.text !== 'prune' ||
    !isImportMetaHot(prune.expression.expression) ||
    prune.arguments.length !== 1
  ) {
    return undefined;
  }

  const callback = prune.arguments[0];
  if (!ts.isArrowFunction(callback) || !ts.isCallExpression(callback.body)) return undefined;
  return isCallToBinding(callback.body, removeStyleBinding) && callback.body.arguments.length === 1
    ? callback.body
    : undefined;
}

function findUpdateStyleCall(
  statement: ts.Statement,
  updateStyleBinding: string
): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  return isCallToBinding(statement.expression, updateStyleBinding) &&
    statement.expression.arguments.length === 2
    ? statement.expression
    : undefined;
}

function compatibilityError(id: string): Error {
  return new Error(
    `Vite development CSS wrapper compatibility error for ${id}: expected a top-level updateStyle call and import.meta.hot.prune removeStyle callback.`
  );
}

export function transformDevCssModule(
  code: string,
  id: string,
  registryId: string
): TransformResult | undefined {
  if (!STYLESHEET_URL.test(id) || hasDirectQuery(id)) return undefined;

  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let updateStyleBinding: string | undefined;
  let removeStyleBinding: string | undefined;

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !isViteClientImport(statement)) continue;

    for (const specifier of statement.importClause.namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (importedName === 'updateStyle') updateStyleBinding = specifier.name.text;
      if (importedName === 'removeStyle') removeStyleBinding = specifier.name.text;
    }
  }

  if (updateStyleBinding === undefined && removeStyleBinding === undefined) return undefined;
  if (updateStyleBinding === undefined || removeStyleBinding === undefined)
    throw compatibilityError(id);

  const updateStyleCall = source.statements
    .map(statement => findUpdateStyleCall(statement, updateStyleBinding))
    .find((call): call is ts.CallExpression => call !== undefined);
  const removeStyleCall = source.statements
    .map(statement => findPruneCall(statement, removeStyleBinding))
    .find((call): call is ts.CallExpression => call !== undefined);

  if (updateStyleCall === undefined || removeStyleCall === undefined) throw compatibilityError(id);

  const replacements = [
    {
      start: updateStyleCall.getStart(source),
      end: updateStyleCall.getEnd(),
      value: `__novel_isr_dev_styles.publish(${updateStyleCall.arguments.map(arg => arg.getText(source)).join(', ')})`,
    },
    {
      start: removeStyleCall.getStart(source),
      end: removeStyleCall.getEnd(),
      value: `__novel_isr_dev_styles.prune(${removeStyleCall.arguments[0].getText(source)})`,
    },
  ];

  let transformed = code;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.value +
      transformed.slice(replacement.end);
  }

  return {
    code: `import { devStyleRegistry as __novel_isr_dev_styles } from ${JSON.stringify(registryId)};\n${transformed}`,
    map: null,
  };
}
