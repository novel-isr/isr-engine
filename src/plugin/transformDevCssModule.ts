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

interface MutatorBinding {
  name: string;
  declaration: ts.Identifier;
}

interface ViteStyleBindings {
  hasEvidence: boolean;
  updateStyleBindings: MutatorBinding[];
  removeStyleBindings: MutatorBinding[];
  internalAccesses: ts.PropertyAccessExpression[];
  supportedInternalAccesses: Set<ts.PropertyAccessExpression>;
}

function isViteClientSpecifier(value: string): boolean {
  return /(?:^|\/)@vite\/client(?:[?#]|$)/.test(value);
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

function isImportMetaHotInternal(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === '_internal' &&
    isImportMetaHot(node.expression)
  );
}

function collectViteStyleBindings(source: ts.SourceFile): ViteStyleBindings {
  const bindings: ViteStyleBindings = {
    hasEvidence: false,
    updateStyleBindings: [],
    removeStyleBindings: [],
    internalAccesses: [],
    supportedInternalAccesses: new Set(),
  };

  const addBinding = (name: 'updateStyle' | 'removeStyle', declaration: ts.Identifier) => {
    bindings.hasEvidence = true;
    bindings[`${name}Bindings`].push({ name: declaration.text, declaration });
  };

  const visit = (node: ts.Node) => {
    if (isImportMetaHotInternal(node)) {
      bindings.hasEvidence = true;
      bindings.internalAccesses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isViteClientSpecifier(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const specifier of statement.importClause.namedBindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        if (importedName === 'updateStyle' || importedName === 'removeStyle') {
          addBinding(importedName, specifier.name);
        }
      }
      continue;
    }

    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      statement.declarationList.declarations.length !== 1
    ) {
      continue;
    }

    const declaration = statement.declarationList.declarations[0];
    if (declaration === undefined) continue;
    const internalAccess = declaration.initializer;
    if (internalAccess === undefined || !isImportMetaHotInternal(internalAccess)) continue;
    if (!ts.isObjectBindingPattern(declaration.name) || declaration.name.elements.length !== 2)
      continue;

    const extracted: Array<{ importedName: string; declaration: ts.Identifier }> = [];
    for (const element of declaration.name.elements) {
      if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) {
        extracted.length = 0;
        break;
      }
      extracted.push({
        importedName: element.propertyName?.getText(source) ?? element.name.text,
        declaration: element.name,
      });
    }
    if (extracted.length !== 2) continue;
    if (
      !extracted.some(element => element.importedName === 'updateStyle') ||
      !extracted.some(element => element.importedName === 'removeStyle')
    ) {
      continue;
    }

    for (const element of extracted) {
      if (element.importedName === 'updateStyle' || element.importedName === 'removeStyle') {
        addBinding(element.importedName, element.declaration);
      }
    }
    bindings.supportedInternalAccesses.add(internalAccess);
  }

  return bindings;
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

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isImportSpecifier(parent)
  );
}

function collectMutatorReferences(
  source: ts.SourceFile,
  bindings: MutatorBinding[]
): ts.Identifier[] {
  const bindingNames = new Set(bindings.map(binding => binding.name));
  const declarations = new Set(bindings.map(binding => binding.declaration));
  const references: ts.Identifier[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      bindingNames.has(node.text) &&
      !declarations.has(node) &&
      !isNonReferenceIdentifier(node)
    ) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function compatibilityError(id: string, detail: string): Error {
  return new Error(`Vite development CSS wrapper compatibility error for ${id}: ${detail}`);
}

export function transformDevCssModule(
  code: string,
  id: string,
  registryId: string
): TransformResult | undefined {
  if (!STYLESHEET_URL.test(id) || hasDirectQuery(id)) return undefined;

  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = collectViteStyleBindings(source);
  if (!bindings.hasEvidence) return undefined;
  if (bindings.internalAccesses.some(access => !bindings.supportedInternalAccesses.has(access))) {
    throw compatibilityError(id, 'contains unsupported import.meta.hot._internal mutator access.');
  }
  if (bindings.updateStyleBindings.length !== 1 || bindings.removeStyleBindings.length !== 1) {
    throw compatibilityError(id, 'expected one updateStyle and one removeStyle binding.');
  }

  const updateStyleBinding = bindings.updateStyleBindings[0];
  const removeStyleBinding = bindings.removeStyleBindings[0];
  if (updateStyleBinding === undefined || removeStyleBinding === undefined) {
    throw compatibilityError(id, 'expected one updateStyle and one removeStyle binding.');
  }
  if (updateStyleBinding.name === removeStyleBinding.name) {
    throw compatibilityError(id, 'updateStyle and removeStyle must use distinct local bindings.');
  }

  const updateStyleCalls = source.statements
    .map(statement => findUpdateStyleCall(statement, updateStyleBinding.name))
    .filter((call): call is ts.CallExpression => call !== undefined);
  const removeStyleCalls = source.statements
    .map(statement => findPruneCall(statement, removeStyleBinding.name))
    .filter((call): call is ts.CallExpression => call !== undefined);

  if (updateStyleCalls.length !== 1 || removeStyleCalls.length !== 1) {
    throw compatibilityError(
      id,
      'expected exactly one top-level updateStyle call and one import.meta.hot.prune removeStyle callback.'
    );
  }

  const updateStyleCall = updateStyleCalls[0];
  const removeStyleCall = removeStyleCalls[0];
  if (updateStyleCall === undefined || removeStyleCall === undefined) {
    throw compatibilityError(
      id,
      'expected exactly one top-level updateStyle call and one import.meta.hot.prune removeStyle callback.'
    );
  }
  const removeStyleArgument = removeStyleCall.arguments[0];
  if (removeStyleArgument === undefined) {
    throw compatibilityError(id, 'expected the removeStyle callback to receive one stylesheet id.');
  }
  const expectedReferences = new Set<ts.Identifier>([
    updateStyleCall.expression as ts.Identifier,
    removeStyleCall.expression as ts.Identifier,
  ]);
  const references = collectMutatorReferences(source, [updateStyleBinding, removeStyleBinding]);
  if (
    references.length !== expectedReferences.size ||
    references.some(reference => !expectedReferences.has(reference))
  ) {
    throw compatibilityError(id, 'contains unsupported additional Vite DOM-mutator references.');
  }

  const replacements = [
    {
      start: updateStyleCall.getStart(source),
      end: updateStyleCall.getEnd(),
      value: `__novel_isr_dev_styles.publish(${updateStyleCall.arguments.map(arg => arg.getText(source)).join(', ')})`,
    },
    {
      start: removeStyleCall.getStart(source),
      end: removeStyleCall.getEnd(),
      value: `__novel_isr_dev_styles.prune(${removeStyleArgument.getText(source)})`,
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
