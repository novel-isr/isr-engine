import { afterEach, expect, it } from 'vitest';
import { SEOEngine } from '../SEOEngine';

afterEach(() => SEOEngine.resetInstance());

it('regenerates cached sitemap entries when the supplied content timestamp changes', async () => {
  const seo = SEOEngine.getInstance({ baseUrl: 'https://example.com' });
  const routes = ['/article'];
  const first = await seo.generateSitemap(routes);
  expect(first).not.toContain('<lastmod>');

  const lastModified = new Map([['/article', '2024-08-21T10:30:00Z']]);
  const updated = await seo.generateSitemap(routes, lastModified);
  expect(updated).toContain('<lastmod>2024-08-21T10:30:00.000Z</lastmod>');

  const another = await seo.generateSitemap(['/other'], lastModified);
  expect(another).toContain('<loc>https://example.com/other</loc>');
  expect(another).not.toContain('<lastmod>');
});
