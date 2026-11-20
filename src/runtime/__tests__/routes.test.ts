import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineRoutes, resolvePageRoute, resolvePageSeoMeta } from '../routes';

beforeEach(() => vi.stubGlobal('__ISR_ENGINE_COMPILED_ROUTE_MANIFESTS__', undefined));
afterEach(() => vi.unstubAllGlobals());

const defaultPage = () => null;

it('uses the app fallback with empty params and the missing request search parameters', async () => {
  const seo = vi.fn(() => ({ title: 'Missing', noindex: true }));
  const { routes } = defineRoutes({
    routes: [{ path: '/article', load: async () => ({ default: defaultPage }) }],
    notFound: { load: async () => ({ default: defaultPage, seo }) },
  });
  const missing = new URL('https://site.test/nonexistent/?from=article');
  expect(await resolvePageRoute(missing, routes)).toEqual({
    notFound: true,
    seoMeta: { title: 'Missing', noindex: true },
  });
  expect(seo).toHaveBeenCalledWith({
    url: missing,
    pathname: '/nonexistent',
    searchParams: missing.searchParams,
    params: {},
  });
  expect(await resolvePageSeoMeta(missing)).toEqual({ title: 'Missing', noindex: true });
  expect(await resolvePageRoute(new URL('https://site.test/article'), routes)).toEqual({
    notFound: false,
    seoMeta: null,
  });
});

it('keeps a nested route table from determining the status of a custom app', async () => {
  const { routes } = defineRoutes({
    routes: [],
    notFound: { load: async () => ({ default: defaultPage }) },
  });
  const url = new URL('https://site.test/nonexistent');
  expect(await resolvePageRoute(url)).toEqual({ notFound: false, seoMeta: null });
  expect(await resolvePageRoute(url, routes)).toEqual({ notFound: true, seoMeta: null });
});
