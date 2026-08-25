import styles from './styles/ServerOnly.module.scss';

export default function ServerOnlyPage() {
  return (
    <main className={styles.sentinel} data-style-sentinel='server'>
      <h1>Server-only CSS</h1>
      <a href='/' data-nav='home'>
        Home
      </a>
    </main>
  );
}
