'use client';

import { useEffect, useState } from 'react';

import TransientPanel from './TransientPanel.client';
import removalStyles from '../styles/Removal.module.scss';
import styles from '../styles/Home.module.scss';

export default function HomeView() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main className={styles.sentinel} data-style-sentinel='home'>
      <h1>Home</h1>
      <button data-hydration-ready disabled={!hydrated}>
        Client ready
      </button>
      <a href='/article' data-nav='article'>
        Article
      </a>
      <TransientPanel />
      <aside className={removalStyles.removable} data-removable-style='present'>
        removable stylesheet
      </aside>
    </main>
  );
}
