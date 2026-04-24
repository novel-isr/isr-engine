/**
 * SPA fallback runtime —— hook + 组件，**不**接管布局
 *
 * 设计原则：FaaS 入口（entry.tsx）只交接 spaApp；布局（Header/Footer/banner 摆放）
 * 由用户的 SpaApp 组件全权决定，engine 只提供数据流原语：
 *
 *   - `useSpaRouter(url, routes)` —— 路由匹配 + 浏览器侧 fetch + loading/error 状态机
 *   - `<SpaBanner />`              —— 默认降级提示横条（业务可不用，自己写）
 *
 * 业务侧用法（典型）：
 *
 *   // src/spa-app.tsx —— 用户的 SPA 根组件
 *   'use client';
 *   import { useSpaRouter, SpaBanner, type SpaRouteEntry } from '@novel-isr/engine/runtime';
 *   import Header from '@components/Header';
 *   import Footer from '@components/Footer';
 *   import { HomeContent } from './pages/HomeContent';
 *
 *   const ROUTES: SpaRouteEntry[] = [
 *     { path: '/', view: HomeContent, fetch: async ({ searchParams }) => {
 *       const r = await fetch('/api/books');
 *       return { books: (await r.json()).data ?? [], category: searchParams.get('category') };
 *     }},
 *   ];
 *
 *   export default function SpaApp({ url }: { url: URL }) {
 *     const Page = useSpaRouter(url, ROUTES);
 *     return <>
 *       <SpaBanner />
 *       <Header />
 *       <main>{Page}</main>
 *       <Footer />
 *     </>;
 *   }
 *
 *   // src/entry.tsx —— 纯 FaaS 交接（main.tsx 风格）
 *   import SpaApp from './spa-app';
 *   export default { spaApp: SpaApp };
 */
'use client';

import React from 'react';

export interface SpaRouteContext<P = Record<string, string>> {
  pathname: string;
  searchParams: URLSearchParams;
  params: P;
  /** API 基地址 —— SSR 侧用 process.env.API_URL（内网/Docker 名）；SPA 侧用 '/api'（经 nginx 反代） */
  apiBase: string;
  /** 上游传入（locale / A/B variant 等；SSR app.tsx 注入；SPA 侧通常空） */
  meta?: Record<string, unknown>;
}

/**
 * 同构数据路由 —— SSR + SPA 共用同一份配置（loader + Component 模式）
 *
 * 行业事实标准命名（Remix / RR7 / TanStack Router / Solid Start 同款）：
 *   - `loader`    —— 数据加载器（同构：SSR Node + browser 都能跑；不要叫 `fetch` 以免遮蔽全局）
 *   - `Component` —— 展示组件（纯渲染；与全栈 React 组件惯例对齐，大写）
 *   - `tags?`     —— ISR cacheTag 声明（仅 SSR 用；SPA 忽略）
 *
 * 第一性：SSR 渲染期可 await（async Server Component），SPA 渲染必须同步（hooks）。
 * loader/Component 拆开 → SSR 直接 await loader 后渲染 Component；
 *                         SPA useEffect 调用 loader、setState 后渲染同款 Component。
 */
export interface DataRouteEntry {
  /** 路径模式：'/' / '/books/:id'（同 defineRoutes） */
  path: string;
  /**
   * 展示组件 —— 收到 loader 返回的数据作为 props
   * 用 any 是因为各 route 的 data 形态不同，TS 无法通过数组字面量交叉推断；
   * 业务侧自己保证 loader 返回值与 Component props 形状一致
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: React.ComponentType<any>;
  /** 数据加载器 —— 同构（SSR Node 和浏览器 SPA 都跑） */
  loader: (ctx: SpaRouteContext) => Promise<Record<string, unknown>>;
  /** ISR 缓存标签 —— 仅 SSR 侧使用，SPA 侧忽略 */
  tags?: (ctx: SpaRouteContext) => readonly string[];
}

/** 别名（向后兼容名）—— 同构路由就是 SPA 路由 */
export type SpaRouteEntry = DataRouteEntry;

interface CompiledSpaRoute {
  path: string;
  re: RegExp;
  keys: string[];
  loader: DataRouteEntry['loader'];
  Component: DataRouteEntry['Component'];
  tags?: DataRouteEntry['tags'];
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

function matchRoute(
  pathname: string,
  routes: readonly CompiledSpaRoute[]
): { route: CompiledSpaRoute; params: Record<string, string> } | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  for (const route of routes) {
    const m = route.re.exec(clean);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}

const compileCache = new WeakMap<readonly SpaRouteEntry[], CompiledSpaRoute[]>();

function getCompiled(routes: readonly SpaRouteEntry[]): CompiledSpaRoute[] {
  let c = compileCache.get(routes);
  if (!c) {
    c = routes.map(r => ({ ...r, ...compile(r.path) }));
    compileCache.set(routes, c);
  }
  return c;
}

export interface UseSpaRouterOptions {
  /**
   * API 基地址（路由 fetch 拼前缀用）；默认 '' 即使用相对路径 → 经 nginx 反代到真后端
   * 业务的 fetch 一般写 `${apiBase}/api/books`；SSR 侧 apiBase = 'http://localhost:3001' 这种内网地址
   */
  apiBase?: string;
  /** loading 占位；不传 → engine 默认 */
  loading?: React.ReactNode;
  /** 404 占位；不传 → engine 默认 */
  notFound?: React.ReactNode;
  /** 错误渲染；不传 → 简易错误条 */
  renderError?: (error: Error) => React.ReactNode;
}

/**
 * SPA 路由 hook —— 给定 url + routes，返回当前应渲染的 React 节点
 *
 * 内部管：路由匹配 + useEffect fetch + loading/error 状态机；
 * 外部管：往哪儿放（Header/Footer/banner 全由调用方布局）
 */
export function useSpaRouter(
  url: URL,
  routes: readonly DataRouteEntry[],
  options: UseSpaRouterOptions = {}
): React.ReactNode {
  const apiBase = options.apiBase ?? '';
  const compiled = getCompiled(routes);
  const matched = matchRoute(url.pathname, compiled);
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    if (!matched) return;
    let cancelled = false;
    setData(null);
    setError(null);
    const ctx: SpaRouteContext = {
      pathname: url.pathname,
      searchParams: url.searchParams,
      params: matched.params,
      apiBase,
    };
    matched.route.loader(ctx).then(
      d => {
        if (!cancelled) setData(d);
      },
      e => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.pathname, url.search]);

  if (!matched) {
    return (
      options.notFound ?? <p style={{ padding: 24 }}>页面不存在（SPA fallback 仅覆盖公开页）</p>
    );
  }
  if (error) {
    return options.renderError ? (
      options.renderError(error)
    ) : (
      <p style={{ padding: 24, color: '#ffb4b4' }}>加载失败：{error.message}</p>
    );
  }
  if (!data) {
    return options.loading ?? <p style={{ padding: 24, opacity: 0.6 }}>加载中…</p>;
  }
  const Component = matched.route.Component;
  return <Component {...data} />;
}

/**
 * 默认 SPA 降级横条 —— 业务可直接用，也可不用自己写
 *
 * 语义：告诉用户「你看到的不是 SSR 版本，是 SPA 兜底」
 */
export function SpaBanner({
  children = '服务端渲染暂时不可用 —— SPA fallback 模式（数据由浏览器直拉 /api/*）',
  className,
  style,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      style={
        style ?? {
          padding: '8px 16px',
          background: '#f0883e',
          color: '#000',
          fontSize: 13,
          textAlign: 'center',
        }
      }
    >
      {children}
    </div>
  );
}

export interface CreateSpaAppOptions {
  /** 同构数据路由 —— 与 SSR 共用 */
  routes: readonly DataRouteEntry[];
  /**
   * App 外壳（Header + main + Footer 的容器）—— 一般直接复用 SSR Layout 抽出的 AppShell
   * 不传 → 不渲染外壳，只渲染 banner + Page
   */
  shell?: React.ComponentType<{ children: React.ReactNode }>;
  /** 横条；不传 → engine 默认 SpaBanner；传 false 则不渲染 */
  banner?: React.ReactNode | false;
  /** API 基地址；默认 '/api'（经 nginx 反代） */
  apiBase?: string;
  /** loading / notFound / renderError 透传给 useSpaRouter */
  loading?: React.ReactNode;
  notFound?: React.ReactNode;
  renderError?: (error: Error) => React.ReactNode;
}

/**
 * 一站式 SPA App 工厂 —— FaaS 入口直接 export default { spaApp: createSpaApp({...}) }
 *
 * 行为：banner + shell{Page} 组合 + URL 状态由 engine 管
 */
export function createSpaApp(options: CreateSpaAppOptions): React.ComponentType<{ url: URL }> {
  const Shell = options.shell;
  const banner = options.banner === false ? null : (options.banner ?? <SpaBanner />);
  const routerOpts: UseSpaRouterOptions = {
    apiBase: options.apiBase,
    loading: options.loading,
    notFound: options.notFound,
    renderError: options.renderError,
  };

  return function SpaApp({ url }: { url: URL }) {
    const Page = useSpaRouter(url, options.routes, routerOpts);
    const inside = Shell ? <Shell>{Page}</Shell> : Page;
    return (
      <>
        {banner}
        {inside}
      </>
    );
  };
}
