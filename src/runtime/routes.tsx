/**
 * defineRoutes —— Next.js 风格路由表
 *
 * 第一性原理：一条路由 = (path, route module)。Page 可以是：
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
 *   export const { routes } = defineRoutes({
 *     notFound: { load: () => import('./pages/NotFoundPage') },
 *     routes: [
 *       { path: '/',          load: () => import('./pages/HomePage') },
 *       { path: '/books/:id', load: () => import('./components/BookDetail') },
 *       { path: '/about',     load: () => import('./pages/AboutPage') },
 *     ],
 *   });
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

import * as React from 'react';
import type { PageSeoMeta } from '../defaults/runtime/seo-runtime';

declare global {
  var __NOVEL_ISR_ROUTE_MANIFESTS__: RouteManifest[] | undefined;
}

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

type RouteModule = object;
export type RouteModuleLoader = () => Promise<RouteModule>;

export interface RouteModuleRef {
  load: RouteModuleLoader;
  /** 命名导出；默认读取 default */
  export?: string;
}

export interface RouteEntry extends RouteModuleRef {
  path: string;
}

export interface RouteManifest {
  routes: readonly RouteEntry[];
  /** 没匹配到时渲染的 route module；不传 → 返回 null */
  notFound?: RouteModuleRef;
}

export interface DefinedRoutes {
  /** SSR/RSC resolver */
  routes: ResolveRoute;
}

export interface PageSeoContext extends PageProps {
  url: URL;
}

export type PageSeoExport =
  | PageSeoMeta
  | null
  | undefined
  | ((
      ctx: PageSeoContext
    ) => PageSeoMeta | null | undefined | Promise<PageSeoMeta | null | undefined>);

interface CompiledRoute extends RouteEntry {
  re: RegExp;
  keys: string[];
  Component: PageComponent;
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

function resolveRouteComponent(
  ref: RouteModuleRef,
  label: string,
  exportName = 'default',
  fallbackExport?: string
): PageComponent {
  const requestedExport = ref.export ?? exportName;
  return React.lazy(async () => {
    const mod = await ref.load();
    const exports = mod as Record<string, unknown>;
    const component =
      exports[requestedExport] ?? (fallbackExport ? exports[fallbackExport] : undefined);
    if (!component) {
      throw new Error(`Route component "${label}" does not export "${requestedExport}"`);
    }
    return { default: component as PageComponent };
  });
}

function resolvePageComponent(route: RouteEntry): PageComponent {
  return resolveRouteComponent(route, route.path);
}

function createRouteResolver(
  routes: readonly RouteEntry[],
  notFound?: RouteModuleRef
): ResolveRoute {
  const compiled: CompiledRoute[] = routes.map(r => ({
    ...r,
    Component: resolvePageComponent(r),
    ...compile(r.path),
  }));
  const NotFound = notFound ? resolveRouteComponent(notFound, '__not_found__') : undefined;

  return function resolveRoute({ pathname, searchParams }) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    for (const route of compiled) {
      const m = route.re.exec(clean);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      const Page = route.Component;
      return <Page pathname={clean} searchParams={searchParams} params={params} />;
    }
    if (NotFound) {
      return <NotFound pathname={clean} searchParams={searchParams} params={{}} />;
    }
    return null;
  };
}

function createDefinedRoutes(config: RouteManifest): DefinedRoutes {
  registerRouteManifest(config);
  return {
    routes: createRouteResolver(config.routes, config.notFound),
  };
}

export function defineRoutes(config: RouteManifest): DefinedRoutes;
export function defineRoutes(input: RouteManifest): DefinedRoutes {
  return createDefinedRoutes(input);
}

function getRouteRegistry(): RouteManifest[] {
  globalThis.__NOVEL_ISR_ROUTE_MANIFESTS__ ??= [];
  return globalThis.__NOVEL_ISR_ROUTE_MANIFESTS__;
}

function registerRouteManifest(config: RouteManifest): void {
  getRouteRegistry().push(config);
}

export async function resolvePageSeoMeta(url: URL): Promise<PageSeoMeta | null> {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  for (const manifest of getRouteRegistry()) {
    for (const route of manifest.routes) {
      const matched = matchRoute(pathname, route);
      if (!matched) continue;
      return await loadPageSeo(route, {
        url,
        pathname,
        searchParams: url.searchParams,
        params: matched.params,
      });
    }
  }
  return null;
}

function matchRoute(
  pathname: string,
  route: RouteEntry
): { params: Record<string, string> } | null {
  const compiled = compile(route.path);
  const m = compiled.re.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  compiled.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1] ?? '');
  });
  return { params };
}

async function loadPageSeo(route: RouteEntry, ctx: PageSeoContext): Promise<PageSeoMeta | null> {
  const mod = await route.load();
  const exports = mod as Record<string, unknown>;
  const exported = exports.seo ?? exports.generateSeo;
  if (!exported) return null;
  if (typeof exported === 'function') {
    return (
      (await (
        exported as (
          ctx: PageSeoContext
        ) => PageSeoMeta | null | undefined | Promise<PageSeoMeta | null | undefined>
      )(ctx)) ?? null
    );
  }
  return exported as PageSeoMeta;
}
