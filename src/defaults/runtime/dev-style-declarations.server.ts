import { AsyncLocalStorage } from 'node:async_hooks';

import {
  canonicalizeDevStyleId,
  createDevStyleStylesheetHref,
  createDevStyleTransportHref,
} from './dev-style-id';
import {
  assertPinnedDevStyleResourceDispatcher,
  emitDevStylesheetResource,
} from './dev-style-resource-dispatcher.server';

const DEV_STYLE_DECLARATIONS_KEY = '__NOVEL_ISR_DEV_STYLE_DECLARATIONS_V2__';
const DEV_CLIENT_REFERENCE_STYLES_KEY = '__NOVEL_ISR_DEV_CLIENT_REFERENCE_STYLES__';

interface DevStyleDeclarationStore {
  styleIds: string[];
  transportGeneration?: number;
}

interface DevStyleDeclarationOptions {
  transportGeneration?: number;
}

interface PluginRscDependencies {
  css: string[];
  [key: string]: unknown;
}

function getDeclarationStorage(): AsyncLocalStorage<DevStyleDeclarationStore> {
  const globalState = globalThis as typeof globalThis & {
    [DEV_STYLE_DECLARATIONS_KEY]?: AsyncLocalStorage<DevStyleDeclarationStore>;
  };
  globalState[DEV_STYLE_DECLARATIONS_KEY] ??= new AsyncLocalStorage<DevStyleDeclarationStore>();
  return globalState[DEV_STYLE_DECLARATIONS_KEY];
}

function getClientReferenceStyles(): Map<string, string[]> {
  const globalState = globalThis as typeof globalThis & {
    [DEV_CLIENT_REFERENCE_STYLES_KEY]?: Map<string, string[]>;
  };
  globalState[DEV_CLIENT_REFERENCE_STYLES_KEY] ??= new Map<string, string[]>();
  return globalState[DEV_CLIENT_REFERENCE_STYLES_KEY];
}

export function runWithDevStyleDeclarationCollection<T>(
  styleIds: string[],
  operation: () => T,
  options: DevStyleDeclarationOptions = {}
): T {
  return getDeclarationStorage().run(
    { styleIds, transportGeneration: options.transportGeneration },
    operation
  );
}

function validateDependencies(dependencies: unknown): PluginRscDependencies {
  if (
    dependencies === null ||
    typeof dependencies !== 'object' ||
    !Array.isArray((dependencies as { css?: unknown }).css) ||
    !(dependencies as { css: unknown[] }).css.every(value => typeof value === 'string')
  ) {
    throw new Error(
      '[novel-isr] Unsupported @vitejs/plugin-rsc dependency shape. Expected deps.css to be a string array.'
    );
  }
  return dependencies as PluginRscDependencies;
}

export function declareDevStyleDependencies(dependencies: unknown): void {
  const validated = validateDependencies(dependencies);

  const store = getDeclarationStorage().getStore();
  if (!store) return;
  for (const href of validated.css) {
    const id = canonicalizeDevStyleId(href);
    if (!store.styleIds.includes(id)) store.styleIds.push(id);
  }
}

export function prepareDevStyleDependencies(dependencies: unknown): PluginRscDependencies {
  const validated = validateDependencies(dependencies);
  declareDevStyleDependencies(validated);
  const generation = getDeclarationStorage().getStore()?.transportGeneration;
  if (generation === undefined) return validated;
  return {
    ...validated,
    css: validated.css.map(href => createDevStyleTransportHref(href, generation)),
  };
}

export function getDevStyleTransportMedia(): string | undefined {
  return getDeclarationStorage().getStore()?.transportGeneration === undefined
    ? undefined
    : 'not all';
}

export function registerDevClientReferenceStyles(
  referenceId: string,
  styleIds: readonly string[]
): void {
  if (!referenceId || !styleIds.every(styleId => typeof styleId === 'string')) {
    throw new Error('[novel-isr] Invalid development client-reference stylesheet mapping.');
  }
  assertPinnedDevStyleResourceDispatcher();
  getClientReferenceStyles().set(
    referenceId,
    Array.from(new Set(styleIds.map(styleId => canonicalizeDevStyleId(styleId))))
  );
}

export function declareDevClientReferenceStyles(reference: unknown): void {
  if (
    reference === null ||
    typeof reference !== 'object' ||
    !('id' in reference) ||
    typeof reference.id !== 'string' ||
    !('deps' in reference)
  ) {
    throw new Error(
      '[novel-isr] Unsupported @vitejs/plugin-rsc client reference dependency shape.'
    );
  }

  declareDevStyleDependencies(reference.deps);
  const styleIds = getClientReferenceStyles().get(reference.id);
  if (!styleIds) {
    throw new Error(
      `[novel-isr] Missing development stylesheet mapping for client reference ${reference.id}.`
    );
  }
  const collector = getDeclarationStorage().getStore()?.styleIds;
  if (!collector) return;
  const generation = getDeclarationStorage().getStore()?.transportGeneration;
  for (const styleId of styleIds) {
    if (!collector.includes(styleId)) collector.push(styleId);
    const href =
      generation === undefined
        ? createDevStyleStylesheetHref(styleId)
        : createDevStyleTransportHref(styleId, generation);
    emitDevStylesheetResource(href, generation === undefined ? undefined : 'not all');
  }
}
