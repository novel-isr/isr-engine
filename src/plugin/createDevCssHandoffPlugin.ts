import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import type { Plugin } from 'vite';

import { transformDevCssModule } from './transformDevCssModule';

export const VITE_RSC_REMOVE_DUPLICATE_CSS_ID = 'virtual:vite-rsc/remove-duplicate-server-css';
export const DEV_CSS_HANDOFF_RESOLVED_ID = '\0virtual:novel-isr/dev-css-handoff';
export const DEV_STYLE_REGISTRY_ID = 'virtual:novel-isr/dev-style-registry';
export const DEV_STYLE_REGISTRY_RESOLVED_ID = '\0virtual:novel-isr/dev-style-registry';
const VITE_RSC_CSS_RESOLVED_PREFIX = '\0virtual:vite-rsc/css?';
const STYLESHEET_URL = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:[?#]|$)/i;

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

  return [
    {
      name: 'isr:dev-css-handoff',
      apply: 'serve',
      enforce: 'pre',
      resolveId(id) {
        if (id === VITE_RSC_REMOVE_DUPLICATE_CSS_ID) return DEV_CSS_HANDOFF_RESOLVED_ID;
        return undefined;
      },
      load(id) {
        if (id !== DEV_CSS_HANDOFF_RESOLVED_ID) return undefined;
        return readFileSync(lifecycleBoundaryPath, 'utf8');
      },
      transform(code, id) {
        return canonicalizeDevRscStylesheetModule(code, id);
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
