/**
 * @novel-isr/engine/runtime —— 业务页面通用运行时
 *
 * 与主入口 `@novel-isr/engine`（Node 编排层）严格隔离，浏览器 + RSC 都安全
 *
 * 用法：
 *   import { defineRoutes, Boundary, parseLocale } from '@novel-isr/engine/runtime';
 */

export { Boundary, ErrorBoundary } from './boundary';
export {
  parseLocale,
  withLocale,
  negotiateLocale,
  alternates,
  resolveI18nConfig,
  type I18nConfig,
  type ParsedLocale,
} from './i18n';
export {
  getI18n,
  getI18nLocale,
  getCurrentI18n,
  setClientI18n,
  type I18nParams,
  type Translate,
} from './i18n-store';
export { LocaleProvider, useLocale } from './LocaleContext';

// 路由 —— route module 风格（{ path, load: () => import('./pages/HomePage') }）
export {
  defineRoutes,
  resolvePageSeoMeta,
  type RouteEntry,
  type RouteModuleLoader,
  type RouteModuleRef,
  type PageProps,
  type PageComponent,
  type ResolveRoute,
  type RouteManifest,
  type DefinedRoutes,
  type PageSeoContext,
  type PageSeoExport,
} from './routes';
