import { cacheTag } from 'isr-engine/rsc';
import { pageTitles } from './pages';

export function App({ url }: { url: URL }) {
  const page = url.pathname.slice(1);
  if (page === '') cacheTag('hello-home');
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
      </head>
      <body>
        <main>
          <h1>{pageTitles.get(page) ?? 'Page not found'}</h1>
          <nav>
            <a href='/'>Home (ISR)</a> <a href='/about'>About (SSG)</a>{' '}
            <a href='/guides/rendering'>Rendering guide (SSR)</a>
          </nav>
          <p>Rendered at {new Date().toISOString()}</p>
        </main>
      </body>
    </html>
  );
}
