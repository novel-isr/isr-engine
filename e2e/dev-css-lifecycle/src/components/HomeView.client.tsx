'use client';

import TransientPanel from './TransientPanel.client';
import removalStyles from '../styles/Removal.module.scss';
import styles from '../styles/Home.module.scss';

export default function HomeView() {
  return (
    <main className={styles.sentinel} data-style-sentinel='home'>
      <h1>Home</h1>
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
