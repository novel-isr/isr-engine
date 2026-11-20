'use client';
import { useEffect, useState } from 'react';

export default function ProductionView({ route }: { route: string }) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main>
      <h1>{route}</h1>
      <button disabled={!hydrated} onClick={() => setCount(value => value + 1)}>
        Count {count}
      </button>
      <a href={route === 'Home' ? '/article' : '/'} data-nav='route'>
        Navigate
      </a>
      <a href='#details' data-nav='hash'>
        Details
      </a>
      <section id='details' style={{ marginTop: '120vh', paddingBottom: '100vh' }}>
        Page details
      </section>
    </main>
  );
}
