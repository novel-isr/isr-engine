import fs from 'node:fs/promises';
import { cacheTag } from 'isr-engine';
import { LocaleLink, parseLocale } from 'isr-engine/runtime';
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
        <link
          rel='icon'
          href='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII='
        />
      </head>
      <body>
        <LocaleLink locale='zh-CN' config={config.runtime.i18n}>
          中文
        </LocaleLink>
        {source && <p data-ssg-source>{source}</p>}
        {routes({ pathname, searchParams: url.searchParams })}
      </body>
    </html>
  );
}
