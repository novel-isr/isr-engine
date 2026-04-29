/**
 * defineRoutes —— Next.js 风格路由表
 *
 * 第一性原理：一条路由 = (path, page Component)。Page 可以是：
 *   - async Server Component（默认）—— 内部直接 cacheTag / await fetch / getVariant
 *   - 同步 Server Component
 *   - 'use client' Client Component（带 useState/useEffect 等 hooks）
 *
 * Server Action / RSC：标准 React 19 + plugin-rsc 'use server' / 'use client' 指令，
 * engine 不发明新 API。
 *
 * 业务用法：
 *
 *   // src/routes.tsx
 *   import { defineRoutes } from '@novel-isr/engine/runtime';
 *   import HomePage from './pages/HomePage';        // async Server Component
 *   import BookDetail from './components/BookDetail'; // async Server Component
 *   import NotFoundPage from './pages/NotFoundPage';
 *
 *   export const resolveRoute = defineRoutes([
 *     { path: '/',          page: HomePage },
 *     { path: '/books/:id', page: BookDetail },
 *     { path: '/about',     page: AboutPage },
 *   ], { fallback: NotFoundPage });
 *
 *   // src/pages/HomePage.tsx —— 一切都在这里
 *   import { cacheTag } from '@novel-isr/engine/rsc';
 *   export default async function HomePage({ searchParams }) {
 *     cacheTag('books');
 *     const data = await fetch(`${process.env.API_URL}/api/books`).then(r => r.json());
 *     return <HomeContent books={data.data ?? []} />;
 *   }
 *
 * 路径语法：':param' 命名参数 / '/*' 通配后缀
 * Engine 自动把 path params 注入 page 的 `params` 属性
 */

import React from 'react';
import type { DataRouteEntry, SpaRouteContext } from './createSpaApp';

/** 路由匹配后传给 page 的 props */
export interface PageProps {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string>;
}

/**
 * Page 组件 —— 普通 React 组件（async / sync / 'use client' 都可）
 *
 * 用 any 是因为 page 可只接收 PageProps 的子集（如 `({ params })` / `()`）；
 * engine 总是 spread 完整 PageProps，多余 props 被组件忽略
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PageComponent = React.ComponentType<any>;

export interface RouteEntry {
  path: string;
  page: PageComponent;
}

export interface DefineRoutesOptions {
  /** 没匹配到时渲染的组件；不传 → 返回 null */
  fallback?: PageComponent;
}

type LazyModuleMap = Record<string, () => Promise<Record<string, unknown>>>;

type LazyComponentRef = string | PageComponent;

export interface UnifiedRouteEntry {
  path: string;
  /** SSR/RSC 页面组件；string 时从 ssrModules 里按 key lazy 加载 */
  page?: LazyComponentRef;
  /** CSR fallback 展示组件；string 时从 spaModules 里按 key lazy 加载 */
  Component?: LazyComponentRef;
  /** string Component 使用命名导出时填写；默认 'default' */
  exportName?: string;
  /** CSR fallback 数据加载器 */
  loader?: (ctx: SpaRouteContext) => Promise<Record<string, unknown>>;
  /** ISR 缓存标签 —— 仅 SSR 侧使用，SPA 侧忽略 */
  tags?: (ctx: SpaRouteContext) => readonly string[];
}

export interface UnifiedRoutesConfig {
  routes: readonly UnifiedRouteEntry[];
  /** SSR 404 页面；string 时从 ssrModules 里按 key lazy 加载 */
  fallback?: LazyComponentRef;
  /** Vite glob map，仅 SSR/RSC 构建传入 */
  ssrModules?: LazyModuleMap;
  /** Vite glob map，仅 client 构建传入 */
  spaModules?: LazyModuleMap;
}

export interface UnifiedRoutesResult {
  /** SSR/RSC resolver */
  routes: ResolveRoute;
  /** CSR fallback routes */
  spaRoutes: DataRouteEntry[];
}

interface CompiledRoute extends RouteEntry {
  re: RegExp;
  keys: string[];
}

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const hasWildcard = path.endsWith('/*');
  const base = hasWildcard ? path.slice(0, -2) : path;
  const escaped = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return {
    re: new RegExp('^' + (hasWildcard ? pattern + '(?:/.*)?' : pattern) + '$'),
    keys,
  };
}

export type ResolveRoute = (ctx: {
  pathname: string;
  searchParams: URLSearchParams;
}) => React.ReactNode;

function resolveLazyComponent(
  ref: LazyComponentRef | undefined,
  modules: LazyModuleMap | undefined,
  exportName = 'default'
): PageComponent | undefined {
  if (!ref) return undefined;
  if (typeof ref !== 'string') return ref;
  const load = modules?.[ref];
  if (!load) return undefined;
  return React.lazy(async () => {
    const mod = await load();
    const component = mod[exportName];
    if (!component) {
      throw new Error(`Route module "${ref}" does not export "${exportName}"`);
    }
    return { default: component as PageComponent };
  });
}

function createRouteResolver(
  routes: readonly RouteEntry[],
  options: DefineRoutesOptions = {}
): ResolveRoute {
  const compiled: CompiledRoute[] = routes.map(r => ({ ...r, ...compile(r.path) }));
  const Fallback = options.fallback;

  return function resolveRoute({ pathname, searchParams }) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    for (const route of compiled) {
      const m = route.re.exec(clean);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      const Page = route.page;
      return <Page pathname={clean} searchParams={searchParams} params={params} />;
    }
    if (Fallback) {
      return <Fallback pathname={clean} searchParams={searchParams} params={{}} />;
    }
    return null;
  };
}

function createUnifiedRoutes(config: UnifiedRoutesConfig): UnifiedRoutesResult {
  const routeEntries: RouteEntry[] = [];
  const spaRoutes: DataRouteEntry[] = [];

  for (const route of config.routes) {
    const page = resolveLazyComponent(route.page, config.ssrModules);
    if (page) routeEntries.push({ path: route.path, page });

    const Component = resolveLazyComponent(route.Component, config.spaModules, route.exportName);
    if (Component && route.loader) {
      spaRoutes.push({
        path: route.path,
        Component,
        loader: route.loader,
        tags: route.tags,
      });
    }
  }

  const fallback = resolveLazyComponent(config.fallback, config.ssrModules);
  return {
    routes: createRouteResolver(routeEntries, { fallback }),
    spaRoutes,
  };
}

export function defineRoutes(
  routes: readonly RouteEntry[],
  options?: DefineRoutesOptions
): ResolveRoute;
export function defineRoutes(config: UnifiedRoutesConfig): UnifiedRoutesResult;
export function defineRoutes(
  input: readonly RouteEntry[] | UnifiedRoutesConfig,
  options: DefineRoutesOptions = {}
): ResolveRoute | UnifiedRoutesResult {
  if (Array.isArray(input)) {
    return createRouteResolver(input as readonly RouteEntry[], options);
  }
  return createUnifiedRoutes(input as UnifiedRoutesConfig);
}
