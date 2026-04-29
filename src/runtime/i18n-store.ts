import type { IntlPayload } from '../defaults/runtime/seo-runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

export type Translate = (key: string, params?: I18nParams, fallback?: string) => string;

type ServerReader = () => IntlPayload | null | undefined;

let clientIntl: IntlPayload | null = null;
let serverReader: ServerReader | null = null;

const keyPathCache = new Map<string, string[]>();

export function setClientI18n(intl: IntlPayload | null | undefined): void {
  clientIntl = intl ?? null;
}

export function registerServerI18nReader(reader: ServerReader): void {
  serverReader = reader;
}

export function getCurrentI18n(): IntlPayload | null {
  return serverReader?.() ?? clientIntl;
}

export function getI18nLocale(fallback = ''): string {
  return getCurrentI18n()?.locale ?? fallback;
}

export const getI18n: Translate = (key, params, fallback = key) => {
  const value = readPath(getCurrentI18n()?.messages, key);
  const message = typeof value === 'string' && value.trim() ? value : fallback;
  return interpolate(message, params);
};

function readPath(source: unknown, key: string): unknown {
  let path = keyPathCache.get(key);
  if (!path) {
    path = key.split('.');
    keyPathCache.set(key, path);
  }

  let cur = source;
  for (const part of path) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function interpolate(message: string, params?: I18nParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}
