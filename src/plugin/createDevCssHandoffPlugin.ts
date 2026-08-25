import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

function cleanModuleId(id: string): string {
  return id.replace(/[?#].*$/, '');
}

function hasUseClientDirective(code: string, id: string): boolean {
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements.some(
    statement =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === 'use client'
  );
}

export function clientReferenceIdFromProxy(code: string, id: string): string {
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const referenceIds = new Set<string>();
  const visit = (node: ts.Node) => {
    const referenceId = ts.isCallExpression(node) ? node.arguments[1] : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerClientReference' &&
      node.arguments.length === 3 &&
      referenceId !== undefined &&
      ts.isStringLiteral(referenceId)
    ) {
      referenceIds.add(referenceId.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const [referenceId] = referenceIds;
  if (referenceIds.size !== 1 || referenceId === undefined) {
    throw new Error(
      `[novel-isr] Unsupported @vitejs/plugin-rsc client reference proxy shape in ${id}. ` +
        'Expected the pinned 0.5.34 registerClientReference calls.'
    );
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

  if (
    !resourcesStatement ||
    resourcesStatement.declarationList.declarations.length !== 1 ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 4 ||
    factory === undefined ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    factory.parameters.length !== 4 ||
    !ts.isIdentifier(factory.parameters[1]?.name) ||
    factory.parameters[1].name.text !== 'deps'
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
  const initializerCode = code.slice(initializer.getStart(source), initializer.getEnd());
  const replacement = `
const __novel_isr_RscResources = ${initializerCode};
export function Resources() {
  __novel_isr_declare_styles(${depsCode});
  return ${reactCode}.createElement(__novel_isr_RscResources);
}`;

  return {
    code:
      `import { declareDevStyleDependencies as __novel_isr_declare_styles } from ${JSON.stringify(
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
        if (this?.environment.name === 'rsc' && hasUseClientDirective(code, id)) {
          clientReferenceModuleIds.add(cleanModuleId(id));
        }
        return (
          instrumentDevRscStylesheetModule(code, id, declarationsUrl) ??
          canonicalizeDevRscStylesheetModule(code, id)
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
