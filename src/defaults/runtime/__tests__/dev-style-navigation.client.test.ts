import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { createDevStyleNavigationLifecycle } from '../dev-style-navigation.client';
import { createDevStyleRegistry } from '../dev-style-registry.client';

function appendRscLink(document: Document, href: string): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.precedence = 'vite-rsc/client-reference';
  document.head.appendChild(link);
}

describe('development style navigation lifecycle', () => {
  it('does not return a payload from a superseded generation', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    let resolveFirst!: (value: string) => void;
    const first = lifecycle.run(
      () =>
        new Promise<string>(resolve => {
          resolveFirst = resolve;
        })
    );
    const second = lifecycle.run(async () => 'C');

    resolveFirst('B');

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('C');
  });

  it('aborts a navigation whose registry loads after the generation starts', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const lifecycle = createDevStyleNavigationLifecycle();
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => lifecycle.commit(generation),
    });

    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles();

    await expect(
      lifecycle.run(async () => {
        lifecycle.register(registry);
        appendRscLink(document, '/src/B.scss?direct');
        registry.publish('/src/B.scss', '.b{display:grid}');
        throw new Error('RSC navigation aborted');
      })
    ).rejects.toThrow('RSC navigation aborted');

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();

    registry.dispose();
    window.close();
  });
});
