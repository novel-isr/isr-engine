import { readCookie, type CookieHeaderSource } from '../utils/cookie';
import type { I18nConfig } from './i18n';

export const LOCALE_PREFERENCE_COOKIE_NAME = 'isr_locale';
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function isSupportedLocalePreference(
  locale: string | undefined,
  config: I18nConfig
): locale is string {
  return (
    config.prefixDefault === true &&
    config.rememberLocale === true &&
    locale !== undefined &&
    config.locales.includes(locale)
  );
}

export function readLocalePreference(
  source: CookieHeaderSource,
  config: I18nConfig
): string | undefined {
  if (!config.rememberLocale || !config.prefixDefault) return undefined;
  const locale = readCookie(source, LOCALE_PREFERENCE_COOKIE_NAME);
  return isSupportedLocalePreference(locale, config) ? locale : undefined;
}

export function serializeLocalePreference(
  locale: string,
  config: I18nConfig,
  secure: boolean
): string | undefined {
  if (!isSupportedLocalePreference(locale, config)) return undefined;
  const value = encodeURIComponent(locale);
  return `${LOCALE_PREFERENCE_COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
