'use client';
import { useState } from 'react';

export default function ProductionView({ route }: { route: string }) {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>{route}</h1>
      <button onClick={() => setCount(value => value + 1)}>Count {count}</button>
      <a href={route === 'Home' ? '/article' : '/'} data-nav='route'>
        Navigate
      </a>
      <a href='#details' data-nav='hash'>
        Details
      </a>
      <section id='details'>Page details</section>
    </main>
  );
}
