'use client';

import styles from '../styles/Transient.module.scss';

export default function TransientPanel() {
  return (
    <p className={styles.panel} data-transient-panel='primary'>
      primary panel
    </p>
  );
}
