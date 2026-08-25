import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

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
    registry.publish('/src/Card.scss', '.card { color: green; }');
    registry.beginUpdate();
    registry.prune('/src/Card.scss');
    registry.commitUpdate();

    expect(ownerCount()).toBeGreaterThan(0);
    registry.dispose();
    window.close();
  });

  it('keeps a committed registry owner when the matching Vite wrapper is pruned', () => {
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

    try {
      registry.publish('/src/Card.scss', '.card { color: green; }');
      registry.reconcileDocumentStyles(0, ['/src/Card.scss']);
      expect(document.querySelector('link[href*="Card.scss"]')).toBeNull();
      registry.beginUpdate();
      registry.prune('/src/Card.scss');
      registry.commitUpdate();

      expect(ownerCount()).toBeGreaterThan(0);
    } finally {
      registry.dispose();
      window.close();
    }
  });
});
