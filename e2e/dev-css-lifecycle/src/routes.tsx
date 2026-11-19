import { defineRoutes } from 'isr-engine/runtime';

export const { routes } = defineRoutes({
  routes: [
    { path: '/', load: () => import('./HomePage') },
    { path: '/article', load: () => import('./ArticlePage') },
    { path: '/server-only', load: () => import('./ServerOnlyPage') },
  ],
});
