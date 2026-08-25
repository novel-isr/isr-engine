import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { handoffDevClientReferenceStyles } from '../dev-css-handoff.client';
import { createDevStyleRegistry } from '../dev-style-registry.client';

describe('dev client-reference stylesheet ownership', () => {
  it('does not leave a stylesheet without an owner when a pending replacement is pruned', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document;
    document.head.innerHTML = `
      <link rel="stylesheet" href="/src/Card.scss?direct" data-precedence="vite-rsc/client-reference">
    `;
    const ownerCount = () =>
      document.querySelectorAll(
        'link[href*="Card.scss"],style[data-vite-dev-id*="Card.scss"],style[data-novel-isr-dev-style*="Card.scss"]'
      ).length;

    const registry = createDevStyleRegistry(document as unknown as Document);
    registry.publish('/workspace/app/src/Card.scss', '.card { color: green; }');
    registry.beginUpdate();
    registry.prune('/workspace/app/src/Card.scss');
    registry.commitUpdate();

    expect(ownerCount()).toBeGreaterThan(0);
    registry.dispose();
    window.close();
  });

  it.fails('legacy handoff leaves no stylesheet owner when Vite prunes its replacement', () => {
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

    try {
      expect(document.querySelector('link[href*="Card.scss"]')).toBeNull();
      document.querySelector('style[data-vite-dev-id]')?.remove();

      expect(ownerCount()).toBeGreaterThan(0);
    } finally {
      dispose();
      window.close();
    }
  });
});
