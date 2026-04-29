/**
 * @novel-isr/engine/runtime —— 业务页面通用运行时
 *
 * 与主入口 `@novel-isr/engine`（Node 编排层）严格隔离，浏览器 + RSC 都安全
 *
 * 用法：
 *   import { defineRoutes, Boundary, parseLocale, createSpaApp } from '@novel-isr/engine/runtime';
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
export { LocaleProvider, useLocale } from './LocaleContext';

// 路由 —— Next.js 风格（{ path, page: ServerComponent }）
export {
  defineRoutes,
  type RouteEntry,
  type PageProps,
  type PageComponent,
  type DefineRoutesOptions,
  type ResolveRoute,
  type RouteManifest,
  type DefinedRoutes,
} from './routes';

// SPA fallback —— 浏览器侧降级渲染（独立运行模型，不与 SSR routes 共享）
export {
  createSpaApp,
  useSpaRouter,
  SpaBanner,
  type SpaRouteContext,
  type SpaRouteEntry,
  type DataRouteEntry,
  type ComponentSpaRouteEntry,
  type UseSpaRouterOptions,
  type CreateSpaAppOptions,
} from './createSpaApp';
