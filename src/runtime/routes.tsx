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
 *   import { defineRoutes } from 'isr-engine/runtime';
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
 *   import { cacheTag } from 'isr-engine/rsc';
 *   export default async function HomePage({ searchParams }) {
 *     cacheTag('books');
 *     const data = await fetch(`${process.env.API_URL}/api/books`).then(r => r.json());
 *     return <HomeContent books={data.data ?? []} />;
 *   }
 *
 * 路径语法：':param' 命名参数 / '/*' 通配后缀
 * Engine 自动把 path params 注入 page 的 `params` 属性
 */

import { trimTrailingSlashes } from '../utils/trimTrailingSlashes';
import * as React from 'react';
import type { PageSeoMeta } from '../defaults/runtime/seo-runtime';

declare global {
  var __ISR_ENGINE_COMPILED_ROUTE_MANIFESTS__: Map<ResolveRoute, CompiledManifest> | undefined;
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
  /** 路由未匹配时渲染此模块，使用其 seo 导出并返回 HTTP 404。 */
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

interface PreparedPage {
  ref: RouteModuleRef;
  Component: PageComponent;
}

interface CompiledRoute extends PreparedPage {
  re: RegExp;
  keys: string[];
}

interface CompiledManifest {
  routes: CompiledRoute[];
  notFound?: PreparedPage;
}

interface RouteMatch {
  page: PreparedPage;
  params: Record<string, string>;
  notFound?: true;
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

function preparePage(ref: RouteModuleRef, label: string): PreparedPage {
  const exportName = ref.export ?? 'default';
  return {
    ref,
    Component: React.lazy(async () => {
      const mod = (await ref.load()) as Record<string, unknown>;
      const component = mod[exportName];
      if (!component) {
        throw new Error(`Route component "${label}" does not export "${exportName}"`);
      }
      return { default: component as PageComponent };
    }),
  };
}

function matchRoute(manifest: CompiledManifest, pathname: string): RouteMatch | undefined {
  for (const route of manifest.routes) {
    const match = route.re.exec(pathname);
    if (!match) continue;
    const params = Object.fromEntries(
      route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1] ?? '')])
    );
    return { page: route, params };
  }
  if (manifest.notFound) return { page: manifest.notFound, params: {}, notFound: true };
}

function getRouteRegistry(): Map<ResolveRoute, CompiledManifest> {
  return (globalThis.__ISR_ENGINE_COMPILED_ROUTE_MANIFESTS__ ??= new Map());
}

export function defineRoutes(config: RouteManifest): DefinedRoutes {
  const manifest: CompiledManifest = {
    routes: config.routes.map(route => ({
      ...compile(route.path),
      ...preparePage(route, route.path),
    })),
    notFound: config.notFound && preparePage(config.notFound, '__not_found__'),
  };
  const routes: ResolveRoute = ({ pathname, searchParams }) => {
    const clean = trimTrailingSlashes(pathname) || '/';
    const match = matchRoute(manifest, clean);
    if (!match) return null;
    const { Component } = match.page;
    return <Component pathname={clean} searchParams={searchParams} params={match.params} />;
  };
  getRouteRegistry().set(routes, manifest);
  return { routes };
}

function matchRegisteredRoute(
  pathname: string,
  routes: ResolveRoute | undefined,
  includeUnambiguousFallback: boolean
): RouteMatch | undefined {
  const registry = getRouteRegistry();
  const manifest = routes && registry.get(routes);
  if (manifest) return matchRoute(manifest, pathname);

  // Registered tables can supply normal page SEO. Only the app's own resolver
  // can establish its HTTP 404 when a nested router also registers a fallback.
  let fallback: RouteMatch | undefined;
  let ambiguous = false;
  for (const candidate of registry.values()) {
    const matched = matchRoute(candidate, pathname);
    if (!matched) continue;
    if (!matched.notFound) return matched;
    if (!includeUnambiguousFallback) continue;
    if (fallback) ambiguous = true;
    else fallback = matched;
  }
  return ambiguous ? undefined : fallback;
}

export async function resolvePageRoute(
  url: URL,
  routes?: ResolveRoute,
  includeUnambiguousFallback = false
): Promise<{ notFound: boolean; seoMeta: PageSeoMeta | null }> {
  const pathname = trimTrailingSlashes(url.pathname) || '/';
  const matched = matchRegisteredRoute(pathname, routes, includeUnambiguousFallback);
  if (!matched) return { notFound: false, seoMeta: null };
  const seoMeta = await loadPageSeo(matched.page.ref, {
    url,
    pathname,
    searchParams: url.searchParams,
    params: matched.params,
  });
  return { notFound: matched.notFound === true, seoMeta };
}

export async function resolvePageSeoMeta(url: URL): Promise<PageSeoMeta | null> {
  return (await resolvePageRoute(url, undefined, true)).seoMeta;
}

async function loadPageSeo(
  route: RouteModuleRef,
  ctx: PageSeoContext
): Promise<PageSeoMeta | null> {
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
