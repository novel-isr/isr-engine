'use client';

import styles from '../styles/Article.module.scss';

export default function ArticleView() {
  return (
    <main className={styles.sentinel} data-style-sentinel='article'>
      <h1>Article</h1>
      <a href='/' data-nav='home'>
        Home
      </a>
    </main>
  );
}
