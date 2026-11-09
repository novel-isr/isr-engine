import ProductionView from './view.client';
import fs from 'node:fs/promises';
import { cacheTag } from '@novel-isr/engine';

export async function App({ url }: { url: URL }) {
  const regenerated = url.pathname === '/regenerated';
  if (regenerated) cacheTag('production-ssg-source');
  const source = regenerated
    ? await fs.readFile('ssg-source.txt', 'utf8').catch(() => 'build-source')
    : undefined;
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <title>Production regression fixture</title>
      </head>
      <body>
        {source && <p data-ssg-source>{source}</p>}
        <ProductionView route={url.pathname === '/article' ? 'Article' : 'Home'} />
      </body>
    </html>
  );
}
