/**
 * LocaleProvider / useLocale —— 客户端 locale context（极小）
 *
 * 不内置消息字典；只暴露当前 locale + I18nConfig 给组件
 * 切换语言用 withLocale + <a href> 触发整页导航即可（SSR 重新分派）
 */
'use client';

import * as React from 'react';
import type { I18nConfig } from './i18n';

interface LocaleContextValue {
  locale: string;
  config: I18nConfig;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  config,
  children,
}: {
  locale: string;
  config: I18nConfig;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ locale, config }), [locale, config]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocale() must be used inside <LocaleProvider>');
  }
  return ctx;
}
