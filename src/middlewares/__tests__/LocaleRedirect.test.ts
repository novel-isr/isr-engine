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
      const result = await new Promise<{ status?: number; location?: string }>(
        (resolve, reject) => {
          const req = http.get(base, { path: rawPath, headers: { host: 'spoof.invalid' } }, res => {
            res.resume();
            res.once('end', () =>
              resolve({ status: res.statusCode, location: res.headers.location })
            );
          });
          req.once('error', reject);
        }
      );
      expect(result).toEqual({ status, location });
      if (result.location) expect(new URL(result.location, base).origin).toBe(base);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('redirects to an acceptable locale or returns 406 when all are rejected', async () => {
  const app = express();
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
      await result.body?.cancel();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
