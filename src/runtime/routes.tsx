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
import type { SpaRouteEntry } from './createSpaApp';

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

type RouteModule = Record<string, unknown>;
export type RouteModuleLoader = () => Promise<RouteModule>;

export interface RouteModuleRef {
  load: RouteModuleLoader;
  /** 命名导出；默认读取 default */
  export?: string;
}

export type RouteComponentRef = PageComponent | RouteModuleRef;

export interface RouteEntry {
  path: string;
  /**
   * 推荐写法：一个 route module 同时承载不同执行视图。
   *
   * - default export: SSR/RSC page
   * - named export `Spa`: CSR shell view（可选；未提供时回退 default）
   */
  load?: RouteModuleLoader;
  /** 兼容旧写法；新业务优先使用 load */
  page?: RouteComponentRef;
  /**
   * CSR shell 页面。
   *
   * 不传时该路由只参与 SSR/RSC；传入时 engine 自动生成 spaRoutes。
   * 数据加载必须内聚在 client 页面内部，业务路由表不再暴露 loader。
   */
  spa?: RouteComponentRef;
}

export interface DefineRoutesOptions {
  /** 没匹配到时渲染的组件；不传 → 返回 null */
  fallback?: RouteComponentRef;
}

export interface RouteManifest {
  routes: readonly RouteEntry[];
  /** 推荐写法：404 route module。保留 fallback 仅做兼容。 */
  notFound?: RouteComponentRef;
  fallback?: RouteComponentRef;
}

export interface DefinedRoutes {
  /** SSR/RSC resolver */
  routes: ResolveRoute;
  /** CSR shell routes，由 engine 从同一份 route manifest 派生 */
  spaRoutes: SpaRouteEntry[];
}

interface CompiledRoute extends RouteEntry {
  re: RegExp;
  keys: string[];
  page: PageComponent;
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

function isRouteModuleRef(ref: RouteComponentRef | undefined): ref is RouteModuleRef {
  return Boolean(ref && typeof ref === 'object' && 'load' in ref && typeof ref.load === 'function');
}

function resolveRouteComponent(
  ref: RouteComponentRef,
  label: string,
  exportName = 'default',
  fallbackExport?: string
): PageComponent {
  if (!isRouteModuleRef(ref)) return ref;
  const requestedExport = ref.export ?? exportName;
  return React.lazy(async () => {
    const mod = await ref.load();
    const component = mod[requestedExport] ?? (fallbackExport ? mod[fallbackExport] : undefined);
    if (!component) {
      throw new Error(`Route component "${label}" does not export "${requestedExport}"`);
    }
    return { default: component as PageComponent };
  });
}

function resolvePageComponent(route: RouteEntry): PageComponent {
  const ref = route.page ?? (route.load ? { load: route.load } : undefined);
  if (!ref) throw new Error(`Route "${route.path}" must define "load" or "page"`);
  return resolveRouteComponent(ref, route.path);
}

function resolveSpaComponent(route: RouteEntry): PageComponent | undefined {
  const ref = route.spa ?? (route.load ? { load: route.load } : undefined);
  return ref ? resolveRouteComponent(ref, `${route.path}:spa`, 'Spa', 'default') : undefined;
}

function createRouteResolver(
  routes: readonly RouteEntry[],
  options: DefineRoutesOptions = {}
): ResolveRoute {
  const compiled: CompiledRoute[] = routes.map(r => ({
    ...r,
    page: resolvePageComponent(r),
    ...compile(r.path),
  }));
  const Fallback = options.fallback
    ? resolveRouteComponent(options.fallback, '__fallback__')
    : undefined;

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

function createDefinedRoutes(config: RouteManifest): DefinedRoutes {
  const fallback = config.notFound ?? config.fallback;
  return {
    routes: createRouteResolver(config.routes, {
      fallback: fallback ? resolveRouteComponent(fallback, '__not_found__') : undefined,
    }),
    spaRoutes: config.routes
      .map(route => {
        const Component = resolveSpaComponent(route);
        return Component ? { path: route.path, Component } : null;
      })
      .filter((route): route is SpaRouteEntry => Boolean(route)),
  };
}

export function defineRoutes(
  routes: readonly RouteEntry[],
  options?: DefineRoutesOptions
): ResolveRoute;
export function defineRoutes(config: RouteManifest): DefinedRoutes;
export function defineRoutes(
  input: readonly RouteEntry[] | RouteManifest,
  options: DefineRoutesOptions = {}
): ResolveRoute | DefinedRoutes {
  if (Array.isArray(input)) {
    return createRouteResolver(input as readonly RouteEntry[], options);
  }
  return createDefinedRoutes(input as RouteManifest);
}
