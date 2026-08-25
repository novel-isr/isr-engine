import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { handoffDevClientReferenceStyles } from '../dev-css-handoff.client';

describe('dev client-reference stylesheet handoff', () => {
  it('does not leave a stylesheet without an owner when Vite prunes its replacement', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document;
    document.head.innerHTML = `
      <link rel="stylesheet" href="/src/Card.scss?direct" data-precedence="vite-rsc/client-reference">
      <style data-vite-dev-id="/workspace/app/src/Card.scss">.card { color: green; }</style>
    `;
    const ownerCount = () =>
      document.querySelectorAll(
        'link[href*="Card.scss"],style[data-vite-dev-id*="Card.scss"],style[data-novel-isr-dev-style*="Card.scss"]'
      ).length;

    const dispose = handoffDevClientReferenceStyles(document as unknown as Document);
    await new Promise(resolve => setTimeout(resolve, 0));

    document.querySelector('style[data-vite-dev-id]')?.remove();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ownerCount()).toBeGreaterThan(0);
    dispose();
    window.close();
  });
});
