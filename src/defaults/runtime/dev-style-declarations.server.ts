import { AsyncLocalStorage } from 'node:async_hooks';

import { canonicalizeDevStyleId } from './dev-style-id';

const DEV_STYLE_DECLARATIONS_KEY = '__NOVEL_ISR_DEV_STYLE_DECLARATIONS__';
const DEV_CLIENT_REFERENCE_STYLES_KEY = '__NOVEL_ISR_DEV_CLIENT_REFERENCE_STYLES__';

function getDeclarationStorage(): AsyncLocalStorage<string[]> {
  const globalState = globalThis as typeof globalThis & {
    [DEV_STYLE_DECLARATIONS_KEY]?: AsyncLocalStorage<string[]>;
  };
  globalState[DEV_STYLE_DECLARATIONS_KEY] ??= new AsyncLocalStorage<string[]>();
  return globalState[DEV_STYLE_DECLARATIONS_KEY];
}

function getClientReferenceStyles(): Map<string, string[]> {
  const globalState = globalThis as typeof globalThis & {
    [DEV_CLIENT_REFERENCE_STYLES_KEY]?: Map<string, string[]>;
  };
  globalState[DEV_CLIENT_REFERENCE_STYLES_KEY] ??= new Map<string, string[]>();
  return globalState[DEV_CLIENT_REFERENCE_STYLES_KEY];
}

export function runWithDevStyleDeclarationCollection<T>(styleIds: string[], operation: () => T): T {
  return getDeclarationStorage().run(styleIds, operation);
}

export function declareDevStyleDependencies(dependencies: unknown): void {
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

  const collector = getDeclarationStorage().getStore();
  if (!collector) return;
  for (const href of (dependencies as { css: string[] }).css) {
    const id = canonicalizeDevStyleId(href);
    if (!collector.includes(id)) collector.push(id);
  }
}

export function registerDevClientReferenceStyles(
  referenceId: string,
  styleIds: readonly string[]
): void {
  if (!referenceId || !styleIds.every(styleId => typeof styleId === 'string')) {
    throw new Error('[novel-isr] Invalid development client-reference stylesheet mapping.');
  }
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
  const collector = getDeclarationStorage().getStore();
  if (!collector) return;
  for (const styleId of styleIds) {
    if (!collector.includes(styleId)) collector.push(styleId);
  }
}
