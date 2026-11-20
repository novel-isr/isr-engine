import { defineRoutes } from 'isr-engine/runtime';

export const { routes } = defineRoutes({
  routes: ['/', '/article', '/articles/:slug', '/static', '/cached', '/regenerated', '/health'].map(
    path => ({ path, load: () => import('./page') })
  ),
  notFound: { load: () => import('./not-found') },
});
