import type { FetchHandler } from '../ssg/spider';

/** Resolve the built RSC module once, retaining the selected export's receiver. */
export function resolveFetchHandler(module: unknown): FetchHandler {
  const mod = module as
    | { default?: { fetch?: unknown } | null; fetch?: unknown }
    | null
    | undefined;
  const defaultOwner = mod?.default;
  const defaultFetch = defaultOwner?.fetch;
  if (typeof defaultFetch === 'function') {
    return { fetch: defaultFetch.bind(defaultOwner) as FetchHandler['fetch'] };
  }
  const namedFetch = mod?.fetch;
  if (typeof namedFetch === 'function') {
    return { fetch: namedFetch.bind(mod) as FetchHandler['fetch'] };
  }
  throw new TypeError('dist/rsc/index.js 未导出可调用的 { fetch } 或 default.fetch');
}
