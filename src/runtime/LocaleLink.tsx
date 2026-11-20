import type { ComponentPropsWithoutRef } from 'react';
import type { I18nConfig } from './i18n';

export type LocaleLinkProps = Omit<
  ComponentPropsWithoutRef<'a'>,
  'href' | 'hrefLang' | 'role' | 'aria-disabled' | 'download' | 'onClick' | 'onClickCapture'
> & {
  locale: string;
  config: I18nConfig;
};

/** Switch the current route's locale through the engine's browser navigation. */
export function LocaleLink({ locale, config, ...props }: LocaleLinkProps) {
  const { locales, defaultLocale, prefixDefault } = config;
  return (
    <a
      {...props}
      role='link'
      hrefLang={locale}
      data-prefetch='false'
      aria-disabled='true'
      data-isr-locale-link={JSON.stringify({ locale, locales, defaultLocale, prefixDefault })}
      suppressHydrationWarning
    />
  );
}
