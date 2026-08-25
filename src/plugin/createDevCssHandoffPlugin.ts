import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import type { EnvironmentModuleNode, Plugin, ViteDevServer } from 'vite';

import { transformDevCssModule } from './transformDevCssModule';

export const VITE_RSC_REMOVE_DUPLICATE_CSS_ID = 'virtual:vite-rsc/remove-duplicate-server-css';
export const DEV_CSS_HANDOFF_RESOLVED_ID = '\0virtual:novel-isr/dev-css-handoff';
export const DEV_STYLE_REGISTRY_ID = 'virtual:novel-isr/dev-style-registry';
export const DEV_STYLE_REGISTRY_RESOLVED_ID = '\0virtual:novel-isr/dev-style-registry';
const VITE_RSC_CSS_RESOLVED_PREFIX = '\0virtual:vite-rsc/css?';
const STYLESHEET_URL = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:[?#]|$)/i;
const SPECIAL_STYLESHEET_QUERY = /[?&](?:direct|inline|raw|url)(?:[=&]|$)/;
let pinnedRscServerRuntimePath: string | undefined;

function getPinnedRscServerRuntimePath(): string {
  if (pinnedRscServerRuntimePath) return pinnedRscServerRuntimePath;
  const requireFromEngine = createRequire(
    typeof import.meta.url === 'string' ? import.meta.url : __filename
  );
  pinnedRscServerRuntimePath = realpathSync(
    requireFromEngine.resolve('@vitejs/plugin-rsc/react/rsc/server')
  );
  return pinnedRscServerRuntimePath;
}

function cleanModuleId(id: string): string {
  return id.replace(/[?#].*$/, '');
}

function hasUseClientDirective(code: string, id: string): boolean {
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function unsupportedClientProxy(id: string): Error {
  return new Error(
    `[novel-isr] Unsupported @vitejs/plugin-rsc client reference proxy shape in ${id}. ` +
      'Expected the pinned 0.5.34 registerClientReference wrapper.'
  );
}

function isPinnedRscServerRuntime(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return false;
    url.search = '';
    url.hash = '';
    return realpathSync(fileURLToPath(url)) === getPinnedRscServerRuntimePath();
  } catch {
    return false;
  }
}

function decodeModuleId(value: string): string | undefined {
  try {
    return decodeURIComponent(value).replaceAll('\\', '/');
  } catch {
    return undefined;
  }
}

function referenceMatchesModule(referenceId: string, moduleId: string): boolean {
  const reference = decodeModuleId(referenceId);
  const module = decodeModuleId(cleanModuleId(moduleId));
  if (!reference || !module) return false;
  if (module === reference || module.endsWith(reference)) return true;
  if (module.startsWith('\0')) {
    return reference === `/@id/__x00__${module.slice(1)}`;
  }
  const packageProxy = '/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/';
  return (
    reference.startsWith(packageProxy) &&
    module === decodeModuleId(reference.slice(packageProxy.length))
  );
}

function registerClientReferenceCall(
  expression: ts.Expression,
  runtimeBinding: string,
  exportName: string,
  moduleId: string
): string | undefined {
  if (
    !ts.isCallExpression(expression) ||
    expression.questionDotToken !== undefined ||
    expression.typeArguments !== undefined ||
    expression.arguments.length !== 3 ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.questionDotToken !== undefined ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== runtimeBinding ||
    expression.expression.name.text !== 'registerClientReference' ||
    !isPinnedClientReferenceProxy(expression.arguments[0], exportName) ||
    !ts.isStringLiteral(expression.arguments[1]) ||
    !ts.isStringLiteral(expression.arguments[2]) ||
    expression.arguments[2].text !== exportName ||
    !referenceMatchesModule(expression.arguments[1].text, moduleId)
  ) {
    return undefined;
  }
  return expression.arguments[1].text;
}

function isPinnedClientReferenceError(node: ts.Expression, exportName: string): boolean {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isBinaryExpression(node.left) ||
    node.left.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    return false;
  }
  return (
    ts.isStringLiteral(node.left.left) &&
    node.left.left.text === "Unexpectedly client reference export '" &&
    ts.isStringLiteral(node.left.right) &&
    node.left.right.text === exportName &&
    ts.isStringLiteral(node.right) &&
    node.right.text === "' is called on server"
  );
}

function isPinnedClientReferenceProxy(
  expression: ts.Expression | undefined,
  exportName: string
): boolean {
  if (
    !expression ||
    !ts.isArrowFunction(expression) ||
    expression.modifiers !== undefined ||
    expression.typeParameters !== undefined ||
    expression.parameters.length !== 0 ||
    expression.type !== undefined ||
    !ts.isBlock(expression.body) ||
    expression.body.statements.length !== 1
  ) {
    return false;
  }
  const statement = expression.body.statements[0];
  if (!statement || !ts.isThrowStatement(statement) || !statement.expression) return false;
  const error = statement.expression;
  const message = ts.isNewExpression(error) ? error.arguments?.[0] : undefined;
  return (
    ts.isNewExpression(error) &&
    ts.isIdentifier(error.expression) &&
    error.expression.text === 'Error' &&
    error.typeArguments === undefined &&
    error.arguments?.length === 1 &&
    message !== undefined &&
    isPinnedClientReferenceError(message, exportName)
  );
}

export function clientReferenceIdFromProxy(code: string, id: string): string {
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const runtimeImports = source.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isPinnedRscServerRuntime(statement.moduleSpecifier.text) &&
      statement.modifiers === undefined &&
      statement.importClause?.name === undefined &&
      statement.importClause?.isTypeOnly === false &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.name.text === '$$ReactServer' &&
      statement.attributes === undefined
  );
  if (runtimeImports.length !== 1) throw unsupportedClientProxy(id);
  const runtimeImport = runtimeImports[0];
  const runtimeBindings = runtimeImport?.importClause?.namedBindings;
  if (!runtimeImport || !runtimeBindings || !ts.isNamespaceImport(runtimeBindings)) {
    throw unsupportedClientProxy(id);
  }
  const runtimeBinding = runtimeBindings.name.text;
  const referenceIds = new Set<string>();

  for (const statement of source.statements) {
    if (statement === runtimeImport) continue;
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const referenceId = registerClientReferenceCall(
        statement.expression,
        runtimeBinding,
        'default',
        id
      );
      if (!referenceId) throw unsupportedClientProxy(id);
      referenceIds.add(referenceId);
      continue;
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.length === 1 &&
      statement.modifiers[0]?.kind === ts.SyntaxKind.ExportKeyword &&
      (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) ===
        ts.NodeFlags.Const &&
      statement.declarationList.declarations.length === 1
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.exclamationToken !== undefined ||
          declaration.type !== undefined ||
          !declaration.initializer
        ) {
          throw unsupportedClientProxy(id);
        }
        const referenceId = registerClientReferenceCall(
          declaration.initializer,
          runtimeBinding,
          declaration.name.text,
          id
        );
        if (!referenceId) throw unsupportedClientProxy(id);
        referenceIds.add(referenceId);
      }
      continue;
    }
    throw unsupportedClientProxy(id);
  }

  const [referenceId] = referenceIds;
  if (referenceIds.size !== 1 || referenceId === undefined) {
    throw unsupportedClientProxy(id);
  }
  return referenceId;
}

async function collectClientReferenceStyles(server: ViteDevServer, id: string): Promise<string[]> {
  const environment = server.environments.client;
  const cleanId = cleanModuleId(id);
  const requestUrl = cleanId.startsWith(server.config.root)
    ? cleanId.slice(server.config.root.length) || '/'
    : cleanId;
  await environment.transformRequest(requestUrl);
  const entry =
    environment.moduleGraph.getModuleById(cleanId) ??
    (await environment.moduleGraph.getModuleByUrl(requestUrl));
  if (!entry) {
    throw new Error(`[novel-isr] Could not inspect the client dependency graph for ${id}.`);
  }

  const visited = new Set<EnvironmentModuleNode>();
  const styleIds = new Set<string>();
  const visit = (module: EnvironmentModuleNode) => {
    if (visited.has(module)) return;
    visited.add(module);
    for (const dependency of module.importedModules) {
      const dependencyId = dependency.url || dependency.id;
      if (dependencyId && STYLESHEET_URL.test(dependencyId)) {
        if (!SPECIAL_STYLESHEET_QUERY.test(dependencyId)) styleIds.add(dependencyId);
      } else {
        visit(dependency);
      }
    }
  };
  visit(entry);
  return Array.from(styleIds).sort();
}

function hasDirectQuery(value: string): boolean {
  const queryStart = value.indexOf('?');
  if (queryStart === -1) return false;
  const hashStart = value.indexOf('#', queryStart);
  const query = value.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  return new URLSearchParams(query).has('direct');
}

function withDirectQuery(value: string): string {
  if (!STYLESHEET_URL.test(value) || hasDirectQuery(value)) return value;

  const hashStart = value.indexOf('#');
  const resource = hashStart === -1 ? value : value.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : value.slice(hashStart);
  const separator = resource.includes('?') ? (/[?&]$/.test(resource) ? '' : '&') : '?';
  return `${resource}${separator}direct${hash}`;
}

export function canonicalizeDevRscStylesheetModule(
  code: string,
  id: string
): { code: string; map: null } | undefined {
  if (!id.startsWith(VITE_RSC_CSS_RESOLVED_PREFIX)) return undefined;

  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) {
      const value = withDirectQuery(node.text);
      if (value !== node.text) {
        replacements.push({ start: node.getStart(source), end: node.getEnd(), value });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (replacements.length === 0) return undefined;
  let transformed = code;
  for (const replacement of replacements.reverse()) {
    transformed =
      transformed.slice(0, replacement.start) +
      JSON.stringify(replacement.value) +
      transformed.slice(replacement.end);
  }
  return { code: transformed, map: null };
}

function identifierIs(node: ts.Node | undefined, value: string): node is ts.Identifier {
  return node !== undefined && ts.isIdentifier(node) && node.text === value;
}

function stringIs(node: ts.Node | undefined, value: string): node is ts.StringLiteral {
  return node !== undefined && ts.isStringLiteral(node) && node.text === value;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function isPropertyPath(node: ts.Node, root: string, ...properties: string[]): boolean {
  let current = node;
  for (const property of [...properties].reverse()) {
    if (!ts.isPropertyAccessExpression(current) || current.name.text !== property) return false;
    current = current.expression;
  }
  return identifierIs(current, root);
}

function isCreateElementCall(
  node: ts.Node,
  reactBinding: string,
  argumentCount: number
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === argumentCount &&
    isPropertyPath(node.expression, reactBinding, 'createElement')
  );
}

function isPinnedLinkProps(node: ts.Node, hrefBinding: string, precedenceBinding: string): boolean {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 5) return false;
  const [key, rel, precedence, href, dataHref] = node.properties;
  if (
    !key ||
    !ts.isPropertyAssignment(key) ||
    propertyName(key.name) !== 'key' ||
    !ts.isBinaryExpression(key.initializer) ||
    key.initializer.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !stringIs(key.initializer.left, 'css:') ||
    !identifierIs(key.initializer.right, hrefBinding)
  ) {
    return false;
  }
  if (
    !rel ||
    !ts.isPropertyAssignment(rel) ||
    propertyName(rel.name) !== 'rel' ||
    !stringIs(rel.initializer, 'stylesheet')
  ) {
    return false;
  }
  if (!precedence || !ts.isSpreadAssignment(precedence)) return false;
  const condition = precedence.expression;
  if (
    !ts.isConditionalExpression(condition) ||
    !identifierIs(condition.condition, precedenceBinding) ||
    !ts.isObjectLiteralExpression(condition.whenTrue) ||
    condition.whenTrue.properties.length !== 1 ||
    !ts.isShorthandPropertyAssignment(condition.whenTrue.properties[0]) ||
    condition.whenTrue.properties[0].name.text !== precedenceBinding ||
    !ts.isObjectLiteralExpression(condition.whenFalse) ||
    condition.whenFalse.properties.length !== 0
  ) {
    return false;
  }
  if (
    !href ||
    !ts.isShorthandPropertyAssignment(href) ||
    href.name.text !== hrefBinding ||
    !dataHref ||
    !ts.isPropertyAssignment(dataHref) ||
    propertyName(dataHref.name) !== 'data-rsc-css-href' ||
    !identifierIs(dataHref.initializer, hrefBinding)
  ) {
    return false;
  }
  return true;
}

function isPinnedResourcesFactory(factory: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const parameterNames = ['React', 'deps', 'RemoveDuplicateServerCss', 'precedence'];
  if (
    factory.parameters.length !== parameterNames.length ||
    !factory.parameters.every((parameter, index) => {
      const expected = parameterNames[index];
      return expected !== undefined && identifierIs(parameter.name, expected);
    }) ||
    !ts.isBlock(factory.body) ||
    factory.body.statements.length !== 1
  ) {
    return false;
  }
  const factoryReturn = factory.body.statements[0];
  if (
    !factoryReturn ||
    !ts.isReturnStatement(factoryReturn) ||
    !factoryReturn.expression ||
    !ts.isFunctionExpression(factoryReturn.expression) ||
    !identifierIs(factoryReturn.expression.name, 'Resources') ||
    factoryReturn.expression.parameters.length !== 0 ||
    factoryReturn.expression.body.statements.length !== 1
  ) {
    return false;
  }
  const resourcesReturn = factoryReturn.expression.body.statements[0];
  const resourcesCall =
    resourcesReturn &&
    ts.isReturnStatement(resourcesReturn) &&
    resourcesReturn.expression &&
    isCreateElementCall(resourcesReturn.expression, 'React', 3)
      ? resourcesReturn.expression
      : undefined;
  const [fragment, nullValue, children] = resourcesCall?.arguments ?? [];
  if (
    !resourcesCall ||
    !fragment ||
    !isPropertyPath(fragment, 'React', 'Fragment') ||
    nullValue?.kind !== ts.SyntaxKind.NullKeyword ||
    !children ||
    !ts.isArrayLiteralExpression(children) ||
    children.elements.length !== 2
  ) {
    return false;
  }

  const [linksSpread, cleanup] = children.elements;
  if (
    !linksSpread ||
    !ts.isSpreadElement(linksSpread) ||
    !ts.isCallExpression(linksSpread.expression)
  ) {
    return false;
  }
  const mapCall = linksSpread.expression;
  const mapCallback = mapCall.arguments[0];
  const linkCall =
    mapCallback &&
    ts.isArrowFunction(mapCallback) &&
    isCreateElementCall(mapCallback.body, 'React', 2)
      ? mapCallback.body
      : undefined;
  if (
    !isPropertyPath(mapCall.expression, 'deps', 'css', 'map') ||
    mapCall.arguments.length !== 1 ||
    !mapCallback ||
    !ts.isArrowFunction(mapCallback) ||
    mapCallback.parameters.length !== 1 ||
    !identifierIs(mapCallback.parameters[0]?.name, 'href') ||
    !linkCall ||
    !stringIs(linkCall.arguments[0], 'link') ||
    !linkCall.arguments[1] ||
    !isPinnedLinkProps(linkCall.arguments[1], 'href', 'precedence')
  ) {
    return false;
  }

  if (
    !cleanup ||
    !ts.isBinaryExpression(cleanup) ||
    cleanup.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    !identifierIs(cleanup.left, 'RemoveDuplicateServerCss') ||
    !isCreateElementCall(cleanup.right, 'React', 2) ||
    !identifierIs(cleanup.right.arguments[0], 'RemoveDuplicateServerCss') ||
    !ts.isObjectLiteralExpression(cleanup.right.arguments[1]) ||
    cleanup.right.arguments[1].properties.length !== 1
  ) {
    return false;
  }
  const cleanupKey = cleanup.right.arguments[1].properties[0];
  return (
    cleanupKey !== undefined &&
    ts.isPropertyAssignment(cleanupKey) &&
    propertyName(cleanupKey.name) === 'key' &&
    stringIs(cleanupKey.initializer, 'remove-duplicate-css')
  );
}

function isPinnedDependencies(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 2) return false;
  const properties = new Map(
    node.properties.map(property => [
      propertyName(property.name),
      ts.isPropertyAssignment(property) ? property.initializer : undefined,
    ])
  );
  const js = properties.get('js');
  const css = properties.get('css');
  return (
    properties.size === 2 &&
    js !== undefined &&
    ts.isArrayLiteralExpression(js) &&
    js.elements.every(ts.isStringLiteral) &&
    css !== undefined &&
    ts.isArrayLiteralExpression(css) &&
    css.elements.every(ts.isStringLiteral)
  );
}

function defaultImportBinding(
  statement: ts.Statement | undefined,
  source: string
): string | undefined {
  if (
    statement === undefined ||
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== source ||
    !statement.importClause?.name ||
    statement.importClause.namedBindings
  ) {
    return undefined;
  }
  return statement.importClause.name.text;
}

export function instrumentDevRscStylesheetModule(
  code: string,
  id: string,
  declarationsUrl: string
): { code: string; map: null } | undefined {
  if (!id.startsWith(VITE_RSC_CSS_RESOLVED_PREFIX)) return undefined;
  const query = new URLSearchParams(id.slice(id.indexOf('?') + 1));
  if (query.get('type') !== 'rsc') return undefined;

  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const resourcesStatement = source.statements.find(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true &&
      statement.declarationList.declarations.some(
        declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'Resources'
      )
  );
  const declaration = resourcesStatement?.declarationList.declarations.find(
    declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'Resources'
  );
  const initializer = declaration?.initializer;
  const factory =
    initializer && ts.isCallExpression(initializer)
      ? ts.isParenthesizedExpression(initializer.expression)
        ? initializer.expression.expression
        : initializer.expression
      : undefined;

  const reactBinding = defaultImportBinding(source.statements[0], 'react');
  const cleanupBinding = defaultImportBinding(
    source.statements[1],
    VITE_RSC_REMOVE_DUPLICATE_CSS_ID
  );
  const depsArgument =
    initializer && ts.isCallExpression(initializer) ? initializer.arguments[1] : undefined;

  if (
    source.statements.length !== 3 ||
    reactBinding === undefined ||
    cleanupBinding === undefined ||
    source.statements[2] !== resourcesStatement ||
    !resourcesStatement ||
    resourcesStatement.modifiers?.length !== 1 ||
    resourcesStatement.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword ||
    (resourcesStatement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    resourcesStatement.declarationList.declarations.length !== 1 ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 4 ||
    factory === undefined ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !isPinnedResourcesFactory(factory) ||
    !identifierIs(initializer.arguments[0], reactBinding) ||
    !depsArgument ||
    !isPinnedDependencies(depsArgument) ||
    !identifierIs(initializer.arguments[2], cleanupBinding) ||
    !(
      stringIs(initializer.arguments[3], 'vite-rsc/importer-resources') ||
      identifierIs(initializer.arguments[3], 'undefined')
    )
  ) {
    throw new Error(
      `[novel-isr] Unsupported @vitejs/plugin-rsc server stylesheet resource shape in ${id}. ` +
        'Expected the pinned 0.5.34 Resources factory.'
    );
  }

  const reactCode = code.slice(
    initializer.arguments[0].getStart(source),
    initializer.arguments[0].getEnd()
  );
  const depsCode = code.slice(
    initializer.arguments[1].getStart(source),
    initializer.arguments[1].getEnd()
  );
  const factoryCode = code.slice(factory.getStart(source), factory.getEnd());
  const cleanupCode = code.slice(
    initializer.arguments[2].getStart(source),
    initializer.arguments[2].getEnd()
  );
  const precedenceCode = code.slice(
    initializer.arguments[3].getStart(source),
    initializer.arguments[3].getEnd()
  );
  const replacement = `
const __novel_isr_create_RscResources = ${factoryCode};
export function Resources() {
  const __novel_isr_RscResources = __novel_isr_create_RscResources(
    ${reactCode},
    __novel_isr_prepare_styles(${depsCode}),
    ${cleanupCode},
    ${precedenceCode},
  );
  return ${reactCode}.createElement(__novel_isr_RscResources);
}`;

  return {
    code:
      `import { prepareDevStyleDependencies as __novel_isr_prepare_styles } from ${JSON.stringify(
        declarationsUrl
      )};\n` +
      code.slice(0, resourcesStatement.getStart(source)) +
      replacement +
      code.slice(resourcesStatement.getEnd()),
    map: null,
  };
}

export function createDevCssHandoffPlugin(defaultsDir: string): Plugin {
  const plugin = createDevCssLifecyclePlugins(defaultsDir)[0];
  if (plugin === undefined) throw new Error('Development CSS handoff plugin was not created.');
  return plugin;
}

export function createDevCssLifecyclePlugins(defaultsDir: string): Plugin[] {
  const lifecycleBoundaryPath = path.resolve(defaultsDir, 'runtime/dev-css-handoff.client.ts');
  const registryUrl = pathToFileURL(
    path.resolve(defaultsDir, 'runtime/dev-style-registry.client.ts')
  ).href;
  const navigationLifecycleUrl = pathToFileURL(
    path.resolve(defaultsDir, 'runtime/dev-style-navigation.client.ts')
  ).href;
  const declarationsUrl = pathToFileURL(
    path.resolve(defaultsDir, 'runtime/dev-style-declarations.server.ts')
  ).href;
  const clientReferenceModuleIds = new Set<string>();
  let devServer: ViteDevServer | undefined;

  return [
    {
      name: 'isr:dev-css-handoff',
      apply: 'serve',
      enforce: 'pre',
      configureServer(server) {
        devServer = server;
      },
      resolveId(id) {
        if (id === VITE_RSC_REMOVE_DUPLICATE_CSS_ID) return DEV_CSS_HANDOFF_RESOLVED_ID;
        return undefined;
      },
      load(id) {
        if (id !== DEV_CSS_HANDOFF_RESOLVED_ID) return undefined;
        return readFileSync(lifecycleBoundaryPath, 'utf8');
      },
      transform(code, id) {
        if (this?.environment.name === 'rsc') {
          const moduleId = cleanModuleId(id);
          if (hasUseClientDirective(code, id)) clientReferenceModuleIds.add(moduleId);
          else clientReferenceModuleIds.delete(moduleId);
        }
        const canonicalized = canonicalizeDevRscStylesheetModule(code, id);
        const transportCode = canonicalized?.code ?? code;
        return (
          instrumentDevRscStylesheetModule(transportCode, id, declarationsUrl) ?? canonicalized
        );
      },
    },
    {
      name: 'isr:dev-client-reference-styles',
      apply: 'serve',
      enforce: 'post',
      async transform(code, id) {
        if (this.environment.name !== 'rsc' || !clientReferenceModuleIds.has(cleanModuleId(id))) {
          return undefined;
        }
        if (!devServer) {
          throw new Error(
            '[novel-isr] Development server is unavailable for CSS dependency mapping.'
          );
        }
        const referenceId = clientReferenceIdFromProxy(code, id);
        const styleIds = await collectClientReferenceStyles(devServer, id);
        return {
          code:
            `import { registerDevClientReferenceStyles as __novel_isr_register_client_styles } from ${JSON.stringify(declarationsUrl)};\n` +
            `__novel_isr_register_client_styles(${JSON.stringify(referenceId)}, ${JSON.stringify(styleIds)});\n` +
            code,
          map: null,
        };
      },
    },
    {
      name: 'isr:dev-style-registry',
      apply: 'serve',
      enforce: 'post',
      resolveId(id) {
        return id === DEV_STYLE_REGISTRY_ID ? DEV_STYLE_REGISTRY_RESOLVED_ID : undefined;
      },
      load(id) {
        if (id !== DEV_STYLE_REGISTRY_RESOLVED_ID) return undefined;
        return `
          "use client";
          import { createDevStyleRegistry } from ${JSON.stringify(registryUrl)};
          import {
            completeDevStyleNavigation,
            registerDevStyleRegistry,
          } from ${JSON.stringify(navigationLifecycleUrl)};

          export const devStyleRegistry = createDevStyleRegistry(document, {
            onRscCommit: completeDevStyleNavigation,
          });
          registerDevStyleRegistry(devStyleRegistry);
          import.meta.hot?.on('vite:beforeUpdate', () => devStyleRegistry.beginUpdate());
          import.meta.hot?.on('vite:afterUpdate', () => devStyleRegistry.commitUpdate());
          import.meta.hot?.on('vite:error', () => devStyleRegistry.abortUpdate());
        `;
      },
      transform(code, id) {
        return transformDevCssModule(code, id, DEV_STYLE_REGISTRY_ID);
      },
    },
  ];
}
