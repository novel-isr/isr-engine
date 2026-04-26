/**
 * Bench fixture App —— minimal Server Component routing
 *
 * Routes:
 *   /           Home (ISR)       exercises HIT/MISS/STALE + cacheTag
 *   /about      About (SSG)      exercises express.static SSG path
 *   /books/:id  Book (ISR)       exercises dynamic params + tag-based invalidation
 *   /api/health Health (SSR)     exercises uncached path
 *
 * Inline data only (no remote fetch) so bench measures engine middleware,
 * not network jitter.
 */
import { cacheTag } from '@novel-isr/engine/rsc';

export interface AppProps {
  url: URL;
}

const ITEM_BODY =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua.';

const ITEMS = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  title: 'Item ' + (i + 1),
  body: ITEM_BODY,
}));

function Home() {
  cacheTag('items');
  return (
    <main>
      <h1>Bench Home</h1>
      <ul>
        {ITEMS.map(item => (
          <li key={item.id}>
            <strong>{item.title}</strong>: {item.body}
          </li>
        ))}
      </ul>
    </main>
  );
}

function About() {
  return (
    <main>
      <h1>Bench About (SSG)</h1>
    </main>
  );
}

function BookPage(props: { id: string }) {
  cacheTag('books', 'book:' + props.id);
  return (
    <main>
      <h1>Book {props.id}</h1>
    </main>
  );
}

function HealthPage() {
  return (
    <main>
      <pre>{JSON.stringify({ status: 'ok' })}</pre>
    </main>
  );
}

function NotFound() {
  return (
    <main>
      <h1>404</h1>
    </main>
  );
}

export function App({ url }: AppProps) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return <Home />;
  if (path === '/about') return <About />;
  if (path === '/api/health') return <HealthPage />;
  const m = path.match(/^\/books\/([^/]+)$/);
  if (m) return <BookPage id={m[1]} />;
  return <NotFound />;
}
