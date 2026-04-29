import { AsyncLocalStorage } from 'node:async_hooks';

import type { IntlPayload } from '../defaults/runtime/seo-runtime';
import { getI18n, getI18nLocale, registerServerI18nReader } from '../runtime/i18n-store';

const store = new AsyncLocalStorage<IntlPayload | null>();

export function runWithI18n<T>(intl: IntlPayload | null | undefined, fn: () => T): T {
  return store.run(intl ?? null, fn);
}

export function getCurrentI18n(): IntlPayload | null {
  return store.getStore() ?? null;
}

registerServerI18nReader(getCurrentI18n);

export { getI18n, getI18nLocale };
export type { I18nParams, Translate } from '../runtime/i18n-store';
