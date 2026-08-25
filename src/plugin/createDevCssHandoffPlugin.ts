import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import {
  type ConfigEnv,
  normalizePath,
  type EnvironmentModuleNode,
  type Plugin,
  type UserConfig,
  version as viteVersion,
  type ViteDevServer,
} from 'vite';

import { transformDevCssModule } from './transformDevCssModule';
import {
  canonicalizeDevStyleId,
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
} from '../defaults/runtime/dev-style-id';
import { assertPinnedDevStyleResourceDispatcher } from '../defaults/runtime/dev-style-resource-dispatcher.server';

export const VITE_RSC_REMOVE_DUPLICATE_CSS_ID = 'virtual:vite-rsc/remove-duplicate-server-css';
export const DEV_CSS_HANDOFF_RESOLVED_ID = '\0virtual:novel-isr/dev-css-handoff';
export const DEV_STYLE_REGISTRY_ID = 'virtual:novel-isr/dev-style-registry';
export const DEV_STYLE_REGISTRY_RESOLVED_ID = '\0virtual:novel-isr/dev-style-registry';
const VITE_RSC_CSS_RESOLVED_PREFIX = '\0virtual:vite-rsc/css?';
const STYLESHEET_URL = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:[?#]|$)/i;
const SPECIAL_STYLESHEET_QUERY = /[?&](?:direct|inline|raw|url)(?:[=&]|$)/;
// Keep this in lockstep with Vite 8.0.14's SPECIAL_QUERY_RE: these requests produce values or
// separate execution contexts, so they cannot contribute stylesheets to the document graph.
const TERMINAL_CLIENT_RESOURCE_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
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

const VITE_HMR_TIMESTAMP_VALUE = /^\d{13}$/;
const VITE_DEP_VERSION_RE = /[?&](v=[\w.-]+)\b/;
const DEV_STYLE_GENERATION_VALUE = /^(?:0|[1-9]\d*)$/;
const PINNED_VITE_VERSION = '8.0.14';

export function assertPinnedViteVersion(actualVersion: string): void {
  if (actualVersion !== PINNED_VITE_VERSION) {
    throw new Error(
      `[novel-isr] Development CSS lifecycle requires Vite ${PINNED_VITE_VERSION}; ` +
        `detected ${actualVersion}. Install the engine's exact Vite peer version.`
    );
  }
}

function applyDevCssLifecycle(_config: UserConfig, environment: ConfigEnv): boolean {
  return environment.command === 'serve' && environment.isPreview !== true;
}

function isModuleTransportQueryParameter(parameter: string): boolean {
  const separator = parameter.indexOf('=');
  const key = separator === -1 ? parameter : parameter.slice(0, separator);
  const value = separator === -1 ? '' : parameter.slice(separator + 1);

  if (key === 'direct' || key === 'import') return value === '';
  if (key === 't') return VITE_HMR_TIMESTAMP_VALUE.test(value);
  if (key === 'v') return VITE_DEP_VERSION_RE.test(`?${parameter}`);
  if (key !== DEV_STYLE_TRANSPORT_GENERATION_PARAM) return false;
  if (!DEV_STYLE_GENERATION_VALUE.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function semanticModuleIdentity(id: string): string {
  const hashStart = id.indexOf('#');
  const resource = hashStart === -1 ? id : id.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : id.slice(hashStart);
  const queryStart = resource.indexOf('?');
  if (queryStart === -1) return id;

  const pathname = resource.slice(0, queryStart);
  const semanticQuery = resource
    .slice(queryStart + 1)
    .split('&')
    .filter(parameter => !isModuleTransportQueryParameter(parameter))
    .join('&');
  return `${pathname}${semanticQuery ? `?${semanticQuery}` : ''}${hash}`;
}

function modulePathname(id: string): string {
  return id.replace(/[?#].*$/, '');
}

function moduleSemanticQuery(id: string): string {
  const semanticId = semanticModuleIdentity(id);
  const queryStart = semanticId.indexOf('?');
  if (queryStart === -1) return '';
  const hashStart = semanticId.indexOf('#', queryStart);
  return semanticId.slice(queryStart, hashStart === -1 ? undefined : hashStart);
}

function browserStyleIdForResolvedModule(
  server: ViteDevServer | undefined,
  id: string
): string | undefined {
  const moduleGraph = server?.environments.client.moduleGraph;
  const queryStart = id.indexOf('?');
  const resolvedPath = queryStart === -1 ? id : id.slice(0, queryStart);
  const query = queryStart === -1 ? '' : id.slice(queryStart);
  let mappedId: string | undefined;
  if (resolvedPath.startsWith('/@fs/') || (!server && resolvedPath.startsWith('/src/'))) {
    mappedId = canonicalizeDevStyleId(id);
  } else if (server && path.isAbsolute(resolvedPath)) {
    const normalizedRoot = normalizePath(path.resolve(server.config.root));
    const normalizedPath = normalizePath(path.resolve(resolvedPath));
    const relative = normalizePath(path.relative(normalizedRoot, normalizedPath));
    const browserUrl =
      relative !== '..' && !relative.startsWith('../') ? `/${relative}` : `/@fs/${normalizedPath}`;
    mappedId = canonicalizeDevStyleId(`${browserUrl}${query}`);
  }

  const exactNode = moduleGraph?.getModuleById(id);
  if (exactNode?.url && !exactNode.url.startsWith('\0')) {
    return canonicalizeDevStyleId(exactNode.url);
  }
  if (mappedId === undefined) return undefined;

  const cleanNode = moduleGraph?.getModuleById(modulePathname(id));
  if (cleanNode?.url && !cleanNode.url.startsWith('\0')) {
    const cleanGraphPath = new URL(canonicalizeDevStyleId(cleanNode.url), 'http://novel-isr.local/')
      .pathname;
    const mappedPath = new URL(mappedId, 'http://novel-isr.local/').pathname;
    if (cleanGraphPath !== mappedPath) return undefined;
  }
  return mappedId;
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

function decodePackageProxyTarget(value: string): string | undefined {
  try {
    return decodeURIComponent(value).replaceAll('\\', '/');
  } catch {
    return undefined;
  }
}

const UNRESERVED_PATH_BYTE = /^[A-Za-z\d._~-]$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;

function canonicalPathSegment(segment: string): string | undefined {
  let result = '';
  for (let index = 0; index < segment.length; ) {
    const codePoint = segment.codePointAt(index);
    if (codePoint === undefined) return undefined;
    const character = String.fromCodePoint(codePoint);
    if (character === '%') {
      const hex = segment.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) return undefined;
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      result += UNRESERVED_PATH_BYTE.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      index += 3;
      continue;
    }
    if (/^[A-Za-z\d._~:@+-]$/.test(character)) result += character;
    else {
      result += encodeURIComponent(character).replace(
        /[!'()*]/g,
        value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`
      );
    }
    index += character.length;
  }
  return result;
}

function canonicalFilePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  const hasDrive = WINDOWS_DRIVE_PATH.test(normalized);
  const absolute = normalized.startsWith('/') || hasDrive;
  if (!absolute) return undefined;

  const segments: string[] = [];
  for (const rawSegment of normalized.split('/')) {
    if (rawSegment === '') continue;
    const segment = canonicalPathSegment(rawSegment);
    if (segment === undefined) return undefined;
    if (segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0 || (hasDrive && segments.length === 1)) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const drive = segments[0];
  if (hasDrive && drive) {
    segments[0] = `${drive.charAt(0).toLowerCase()}${drive.slice(1)}`;
    return segments.join('/');
  }
  return `/${segments.join('/')}`;
}

function filePathFromFsUrl(value: string): string | undefined {
  if (!value.startsWith('/@fs/')) return undefined;
  const filePath = value.slice('/@fs/'.length);
  return canonicalFilePath(WINDOWS_DRIVE_PATH.test(filePath) ? filePath : `/${filePath}`);
}

function canonicalModuleFilePath(moduleId: string): string | undefined {
  const cleanId = modulePathname(moduleId);
  return filePathFromFsUrl(cleanId) ?? canonicalFilePath(cleanId);
}

function rootRelativeFilePath(root: string, referenceId: string): string | undefined {
  if (
    !referenceId.startsWith('/') ||
    referenceId.startsWith('//') ||
    referenceId.includes('\\') ||
    referenceId.startsWith('/@')
  ) {
    return undefined;
  }
  const canonicalRoot = canonicalFilePath(root);
  const canonicalReference = canonicalFilePath(referenceId);
  if (!canonicalRoot || !canonicalReference || referenceId.startsWith('/@fs/')) return undefined;
  return canonicalFilePath(`${canonicalRoot}/${canonicalReference.slice(1)}`);
}

function referenceMatchesModule(referenceId: string, moduleId: string, root: string): boolean {
  const normalizedModuleId = semanticModuleIdentity(moduleId.replaceAll('\\', '/'));
  const normalizedReferenceId = semanticModuleIdentity(referenceId);
  if (normalizedModuleId.startsWith('\0')) {
    return normalizedReferenceId === `/@id/__x00__${normalizedModuleId.slice(1)}`;
  }
  const cleanId = modulePathname(normalizedModuleId);

  const packageProxy = '/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/';
  if (normalizedReferenceId.startsWith(packageProxy)) {
    const target = decodePackageProxyTarget(normalizedReferenceId.slice(packageProxy.length));
    const targetPath = target === undefined ? undefined : canonicalModuleFilePath(target);
    const modulePath = canonicalModuleFilePath(cleanId);
    return targetPath !== undefined && modulePath !== undefined && targetPath === modulePath;
  }

  if (moduleSemanticQuery(normalizedReferenceId) !== moduleSemanticQuery(normalizedModuleId)) {
    return false;
  }
  const moduleFilePath = canonicalModuleFilePath(cleanId);
  if (!moduleFilePath) return false;
  const cleanReferenceId = modulePathname(normalizedReferenceId);
  const fsReference = filePathFromFsUrl(cleanReferenceId);
  if (fsReference) return moduleFilePath === fsReference;

  const browserReference = rootRelativeFilePath(root, cleanReferenceId);
  if (!browserReference) return false;
  if (cleanId.startsWith('/') && !cleanId.startsWith('/@fs/')) {
    if (canonicalFilePath(cleanId) === canonicalFilePath(cleanReferenceId)) return true;
  }
  return moduleFilePath === browserReference;
}

function registerClientReferenceCall(
  expression: ts.Expression,
  runtimeBinding: string,
  exportName: string,
  moduleId: string,
  root: string
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
    !referenceMatchesModule(expression.arguments[1].text, moduleId, root)
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

export function clientReferenceIdFromProxy(code: string, id: string, root: string): string {
  const source = ts.createSourceFile(
    id,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  if (source.parseDiagnostics.length > 0) throw unsupportedClientProxy(id);
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
  const exportNames = new Set<string>();

  for (const statement of source.statements) {
    if (statement === runtimeImport) continue;
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (exportNames.has('default')) throw unsupportedClientProxy(id);
      const referenceId = registerClientReferenceCall(
        statement.expression,
        runtimeBinding,
        'default',
        id,
        root
      );
      if (!referenceId) throw unsupportedClientProxy(id);
      referenceIds.add(referenceId);
      exportNames.add('default');
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
          exportNames.has(declaration.name.text) ||
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
          id,
          root
        );
        if (!referenceId) throw unsupportedClientProxy(id);
        referenceIds.add(referenceId);
        exportNames.add(declaration.name.text);
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
  const moduleId = semanticModuleIdentity(id);
  const requestUrl = moduleId.startsWith('\0')
    ? `/@id/__x00__${moduleId.slice(1)}`
    : moduleId.startsWith(server.config.root)
      ? moduleId.slice(server.config.root.length) || '/'
      : moduleId;
  // `transformRequest()` receives Vite's resolved null-byte id directly; the public request URL is
  // retained in full for module-graph lookup. Vite's HTTP transform middleware performs this same
  // `/@id/__x00__` unwrap before calling the environment API.
  await environment.transformRequest(moduleId.startsWith('\0') ? moduleId : requestUrl);
  const entry =
    (await environment.moduleGraph.getModuleByUrl(requestUrl)) ??
    environment.moduleGraph.getModuleById(moduleId);
  if (!entry) {
    throw new Error(`[novel-isr] Could not inspect the client dependency graph for ${id}.`);
  }

  const visited = new Set<EnvironmentModuleNode>();
  const styleIds = new Set<string>();
  const visit = async (module: EnvironmentModuleNode): Promise<void> => {
    if (visited.has(module)) return;
    visited.add(module);

    const transformId = module.id || module.url;
    if (!transformId) return;
    await environment.transformRequest(transformId);
    const transformed =
      (module.id ? environment.moduleGraph.getModuleById(module.id) : undefined) ??
      (module.url ? await environment.moduleGraph.getModuleByUrl(module.url) : undefined) ??
      module;

    for (const dependency of transformed.importedModules) {
      const dependencyId = dependency.url || dependency.id;
      if (dependencyId && STYLESHEET_URL.test(dependencyId)) {
        if (!SPECIAL_STYLESHEET_QUERY.test(dependencyId)) styleIds.add(dependencyId);
      } else if (!dependencyId || !TERMINAL_CLIENT_RESOURCE_QUERY.test(dependencyId)) {
        await visit(dependency);
      }
    }
  };
  await visit(entry);
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

function addTransportMediaToPinnedFactory(
  source: ts.SourceFile,
  code: string,
  factory: ts.ArrowFunction | ts.FunctionExpression
): string {
  let linkProps: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && isPinnedLinkProps(node, 'href', 'precedence')) {
      linkProps = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(factory);
  const lastParameter = factory.parameters[factory.parameters.length - 1];
  if (!linkProps || !lastParameter) {
    throw new Error('Pinned Resources factory lost its stylesheet transport binding.');
  }

  const factoryStart = factory.getStart(source);
  const replacements = [
    {
      position: lastParameter.getEnd() - factoryStart,
      value: ', __novel_isr_transport_media',
    },
    {
      position: linkProps.getEnd() - factoryStart - 1,
      value: ',\n          media: __novel_isr_transport_media',
    },
  ].sort((left, right) => right.position - left.position);
  let factoryCode = code.slice(factoryStart, factory.getEnd());
  for (const replacement of replacements) {
    factoryCode =
      factoryCode.slice(0, replacement.position) +
      replacement.value +
      factoryCode.slice(replacement.position);
  }
  return factoryCode;
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
  const factoryCode = addTransportMediaToPinnedFactory(source, code, factory);
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
    __novel_isr_get_transport_media(),
  );
  return ${reactCode}.createElement(__novel_isr_RscResources);
}`;

  return {
    code:
      `import { getDevStyleTransportMedia as __novel_isr_get_transport_media, prepareDevStyleDependencies as __novel_isr_prepare_styles } from ${JSON.stringify(declarationsUrl)};\n` +
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

export interface DevCssLifecyclePluginPhases {
  /** Must observe raw directives before plugin-rsc replaces client modules with proxies. */
  beforeRsc: Plugin[];
  /** Must observe plugin-rsc proxies and Vite's generated CSS wrappers, respectively. */
  afterRsc: Plugin[];
}

export function createDevCssLifecyclePluginPhases(
  defaultsDir: string
): DevCssLifecyclePluginPhases {
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

  const plugins = [
    {
      name: 'isr:dev-css-handoff',
      apply: applyDevCssLifecycle,
      enforce: 'pre',
      configResolved() {
        assertPinnedViteVersion(viteVersion);
        assertPinnedDevStyleResourceDispatcher();
      },
      configureServer(server) {
        devServer = server;
      },
      resolveId(id) {
        if (id === VITE_RSC_REMOVE_DUPLICATE_CSS_ID) return DEV_CSS_HANDOFF_RESOLVED_ID;
        return undefined;
      },
      load(id) {
        if (id !== DEV_CSS_HANDOFF_RESOLVED_ID) return undefined;
        const boundary = readFileSync(lifecycleBoundaryPath, 'utf8');
        const directive = "'use client';";
        if (!boundary.startsWith(directive)) {
          throw new Error('[novel-isr] Development CSS boundary lost its client directive.');
        }
        if (this.environment.name !== 'client') return boundary;
        return boundary.replace(
          directive,
          `${directive}\n\nimport ${JSON.stringify(DEV_STYLE_REGISTRY_ID)};`
        );
      },
      transform(code, id) {
        if (this?.environment.name === 'rsc') {
          const moduleId = semanticModuleIdentity(id);
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
      apply: applyDevCssLifecycle,
      enforce: 'post',
      async transform(code, id) {
        const moduleId = semanticModuleIdentity(id);
        if (this.environment.name !== 'rsc' || !clientReferenceModuleIds.has(moduleId)) {
          return undefined;
        }
        if (!devServer) {
          throw new Error(
            '[novel-isr] Development server is unavailable for CSS dependency mapping.'
          );
        }
        const referenceId = clientReferenceIdFromProxy(code, moduleId, devServer.config.root);
        const styleIds = await collectClientReferenceStyles(devServer, moduleId);
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
      apply: applyDevCssLifecycle,
      enforce: 'post',
      resolveId(id) {
        return id === DEV_STYLE_REGISTRY_ID ? DEV_STYLE_REGISTRY_RESOLVED_ID : undefined;
      },
      load(id) {
        if (id !== DEV_STYLE_REGISTRY_RESOLVED_ID) return undefined;
        if (this.environment.name !== 'client') {
          return `
            export const devStyleRegistry = {
              publish() {},
              prune() {},
            };
          `;
        }
        return `
          "use client";
          import { getOrCreateDevStyleRegistry } from ${JSON.stringify(registryUrl)};
          import {
            completeDevStyleNavigation,
            registerDevStyleRegistry,
          } from ${JSON.stringify(navigationLifecycleUrl)};

          export const devStyleRegistry = getOrCreateDevStyleRegistry(document, {
            onRscCommit: completeDevStyleNavigation,
          });
          registerDevStyleRegistry(devStyleRegistry);
          import.meta.hot?.on('vite:beforeUpdate', () => devStyleRegistry.beginUpdate());
          import.meta.hot?.on('vite:afterUpdate', () => devStyleRegistry.commitUpdate());
          import.meta.hot?.on('vite:error', () => devStyleRegistry.abortUpdate());
        `;
      },
      transform(code, id) {
        return transformDevCssModule(
          code,
          id,
          DEV_STYLE_REGISTRY_ID,
          browserStyleIdForResolvedModule(devServer, id)
        );
      },
    },
  ] satisfies [Plugin, Plugin, Plugin];

  return {
    beforeRsc: [plugins[0]],
    afterRsc: [plugins[1], plugins[2]],
  };
}

export function createDevCssLifecyclePlugins(defaultsDir: string): Plugin[] {
  const phases = createDevCssLifecyclePluginPhases(defaultsDir);
  return [...phases.beforeRsc, ...phases.afterRsc];
}
