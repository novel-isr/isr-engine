import fs from 'node:fs/promises';
import { cacheTag } from 'isr-engine';
import { parseLocale } from 'isr-engine/runtime';
import config from '../ssr.config';
import { routes } from './routes';

export async function App({ url }: { url: URL }) {
  const { locale, pathname } = parseLocale(url.pathname, config.runtime.i18n);
  const regenerated = pathname === '/regenerated';
  if (regenerated) cacheTag('production-ssg-source');
  const source = regenerated
    ? await fs.readFile('ssg-source.txt', 'utf8').catch(() => 'build-source')
    : undefined;
  return (
    <html lang={locale}>
      <head>
        <meta charSet='utf-8' />
        <title>Production regression app</title>
      </head>
      <body>
        {source && <p data-ssg-source>{source}</p>}
        {routes({ pathname, searchParams: url.searchParams })}
      </body>
    </html>
  );
}
