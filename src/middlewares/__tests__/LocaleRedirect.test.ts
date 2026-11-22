import { expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createLocaleRedirectMiddleware } from '../LocaleRedirect';

it('keeps negotiated and case-folded redirects on-origin and preserves query bytes', async () => {
  const app = express();
  app.use(
    createLocaleRedirectMiddleware({
      i18n: { locales: ['en', 'zh-CN'], defaultLocale: 'en', prefixDefault: true },
    })!
  );
  app.use((_req, res) => res.send('accepted'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [rawPath, status, location] of [
      [
        '/books?keep=a%2Fb&next=//external.invalid',
        302,
        '/en/books?keep=a%2Fb&next=//external.invalid',
      ],
      ['/ZH-cn/books_.rsc?keep=a%2Fb', 308, '/zh-CN/books_.rsc?keep=a%2Fb'],
      ['/ZH-cn/books?', 308, '/zh-CN/books?'],
      ['//external?keep=yes', 302, '/en//external?keep=yes'],
      ['/books\\unsafe', 400, undefined],
    ] as const) {
      const result = await new Promise<{
        status?: number;
        location?: string;
        cacheControl?: string;
      }>((resolve, reject) => {
        const req = http.get(base, { path: rawPath, headers: { host: 'spoof.invalid' } }, res => {
          res.resume();
          res.once('end', () =>
            resolve({
              status: res.statusCode,
              location: res.headers.location,
              cacheControl: res.headers['cache-control'],
            })
          );
        });
        req.once('error', reject);
      });
      expect(result).toMatchObject({ status, location });
      if (status === 302) expect(result.cacheControl).toBe('no-store');
      if (status === 308) expect(result.cacheControl).toBeUndefined();
      if (result.location) expect(new URL(result.location, base).origin).toBe(base);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('redirects to an acceptable locale or returns 406 when all are rejected', async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.vary('Origin');
    next();
  });
  app.use(
    createLocaleRedirectMiddleware({
      i18n: { locales: ['en-US', 'en-AU', 'zh-CN'], defaultLocale: 'en-US', prefixDefault: true },
    })!
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/books`;
  try {
    for (const [acceptLanguage, status, location] of [
      ['en-GB,en-US;q=0', 302, '/en-AU/books'],
      ['en-US;q=0,*;q=0.5', 302, '/en-AU/books'],
      ['*;q=0', 406, null],
    ] as const) {
      const result = await fetch(url, {
        headers: { 'accept-language': acceptLanguage },
        redirect: 'manual',
      });
      expect(result.status).toBe(status);
      expect(result.headers.get('location')).toBe(location);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(result.headers.get('vary')?.split(', ')).toEqual(
        expect.arrayContaining(['Origin', 'Accept-Language', 'Cookie'])
      );
      await result.body?.cancel();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([false, true])(
  'uses a saved preference for the root when enabled (%s)',
  async rememberLocale => {
    const app = express();
    app.use(
      createLocaleRedirectMiddleware({
        i18n: {
          locales: ['en', 'zh-CN'],
          defaultLocale: 'en',
          prefixDefault: true,
          rememberLocale,
        },
      })!
    );
    app.use((_req, res) => res.send('accepted'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = rememberLocale ? '/zh-CN' : '/en';
    try {
      for (const [path, location, cookie = 'isr_locale=zh-CN'] of [
        ['/?query=a%2Fb', `${root}?query=a%2Fb`],
        ['/_.rsc?query=a%2Fb', `${root}_.rsc?query=a%2Fb`],
        ['/books', '/en/books'],
        ['/books', '/zh-CN/books', 'locale=zh-CN; locale=en'],
        ['/en/books', null],
      ] as const) {
        const result = await fetch(new URL(path, base), {
          method: 'HEAD',
          headers: { cookie, 'accept-language': 'en' },
          redirect: 'manual',
        });
        expect(result.status).toBe(location ? 302 : 200);
        expect(result.headers.get('location')).toBe(location);
        expect(result.headers.get('cache-control')).toBe(location ? 'no-store' : null);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
);
