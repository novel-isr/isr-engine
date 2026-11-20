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

it('rejects conflicting publication records for a single URL', async () => {
  const seo = SEOEngine.getInstance({ baseUrl: 'https://example.com' });
  await expect(
    seo.generatePublishedSitemap([
      { path: '/article', status: 'published' },
      { path: '/%61rticle', status: 'unpublished' },
    ])
  ).rejects.toThrow('Duplicate sitemap path');
});

it('rejects a publication sitemap that would exceed the URL limit', async () => {
  const seo = SEOEngine.getInstance({ baseUrl: 'https://example.com' });
  const entries = Array.from({ length: 50_001 }, (_, index) => ({
    path: `/articles/${index}`,
    status: 'published' as const,
  }));
  await expect(seo.generatePublishedSitemap(entries)).rejects.toThrow('50000 URLs');
});

it('rejects a publication URL with 2048 characters including the site origin', async () => {
  const baseUrl = 'https://example.com';
  const seo = SEOEngine.getInstance({ baseUrl });
  const path = '/' + 'a'.repeat(2048 - baseUrl.length - 1);
  await expect(seo.generatePublishedSitemap([{ path, status: 'published' }])).rejects.toThrow(
    'shorter than 2048 characters'
  );
});
