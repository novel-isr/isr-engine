import type { Response } from 'express';
import { createCachedFetcher } from '../defaults/runtime/createCachedFetcher';
import type { SEOEngine } from '../engine/seo/SEOEngine';
import { resolveSitemapLoader } from '../engine/seo/resolveSeoConfig';
import { logger } from '../logger';
import { registerContentInvalidator } from '../rsc/revalidate';
import type { ISRConfig } from '../types';

export function createPublishedSitemap(config: ISRConfig, engine?: SEOEngine) {
  const source = resolveSitemapLoader(config, engine);
  if (!source) return;

  const cached = createCachedFetcher({
    key: () => 'sitemap',
    ttl: source.ttl,
    staleIfErrorMs: source.staleIfErrorMs,
    max: 1,
    async fetch() {
      try {
        return await source.load();
      } catch (error) {
        logger.warn('[SEO] Publication sitemap refresh failed', error);
        throw error;
      }
    },
  });
  let generation = 0;
  const close = registerContentInvalidator(({ sitemap }) => {
    if (sitemap) {
      generation++;
      cached.invalidate();
    }
  });

  return {
    async serve(res: Response): Promise<void> {
      // Readers already waiting on a superseded load also receive the current catalog.
      const isOpen = () => !res.destroyed && !res.writableEnded;
      while (isOpen()) {
        const current = generation;
        try {
          const xml = await cached(undefined);
          if (current !== generation) continue;
          if (isOpen()) res.type('application/xml').set('Cache-Control', 'no-cache').end(xml);
        } catch {
          if (current !== generation) continue;
          if (isOpen())
            res
              .status(503)
              .type('text/plain')
              .set('Cache-Control', 'no-store')
              .end('Sitemap unavailable');
        }
        return;
      }
    },
    close,
  };
}
