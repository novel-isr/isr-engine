import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { handoffDevClientReferenceStyles } from '../dev-css-handoff.client';

describe('dev client-reference stylesheet handoff', () => {
  it('keeps each SSR stylesheet until its matching Vite style exists', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document;
    document.head.innerHTML = `
      <link rel="stylesheet" href="/src/ready.module.scss" data-precedence="vite-rsc/client-reference">
      <link rel="stylesheet" href="/src/pending.module.scss" data-precedence="vite-rsc/client-reference">
      <link rel="stylesheet" href="/src/global.scss" data-precedence="vite-rsc/importer-resources">
      <style data-vite-dev-id="/workspace/app/src/ready.module.scss">.ready { color: green; }</style>
    `;

    const dispose = handoffDevClientReferenceStyles(document as unknown as Document);

    expect(document.querySelector('link[href="/src/ready.module.scss"]')).toBeNull();
    expect(document.querySelector('link[href="/src/pending.module.scss"]')).not.toBeNull();
    expect(document.querySelector('link[href="/src/global.scss"]')).not.toBeNull();

    const replacement = document.createElement('style');
    replacement.dataset.viteDevId = '/workspace/app/src/pending.module.scss';
    replacement.textContent = '.pending { color: green; }';
    document.head.appendChild(replacement);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.querySelector('link[href="/src/pending.module.scss"]')).toBeNull();
    expect(document.querySelector('link[href="/src/global.scss"]')).not.toBeNull();
    dispose();
    window.close();
  });
});
