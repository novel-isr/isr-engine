'use client';

import styles from '../styles/TransientAlt.module.scss';

export default function TransientPanelAlt() {
  return (
    <p className={styles.panel} data-transient-panel='alternate'>
      alternate panel
    </p>
  );
}
