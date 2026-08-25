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
  it('silently supersedes a stale response before any payload side effects run', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    const sideEffects: string[] = [];
    let resolveFirst!: (value: string) => void;
    const first = lifecycle.run(
      () =>
        new Promise<string>(resolve => {
          resolveFirst = resolve;
        }),
      payload => {
        sideEffects.push(
          `url:${payload}`,
          `i18n:${payload}`,
          `seo:${payload}`,
          `payload:${payload}`
        );
        return payload;
      }
    );
    const second = lifecycle.run(
      async () => 'C',
      payload => {
        sideEffects.push(
          `url:${payload}`,
          `i18n:${payload}`,
          `seo:${payload}`,
          `payload:${payload}`
        );
        return payload;
      }
    );

    await expect(second).resolves.toEqual({ status: 'applied', value: 'C', generation: 2 });

    resolveFirst('B');

    await expect(first).resolves.toEqual({ status: 'superseded' });
    expect(sideEffects).toEqual(['url:C', 'i18n:C', 'seo:C', 'payload:C']);
  });

  it('does not add navigation supersession semantics when disabled for production', async () => {
    const lifecycle = createDevStyleNavigationLifecycle({ enabled: false });
    const sideEffects: string[] = [];
    let resolveFirst!: (value: string) => void;
    const first = lifecycle.run(
      () =>
        new Promise<string>(resolve => {
          resolveFirst = resolve;
        }),
      (payload, generation) => {
        sideEffects.push(payload);
        expect(generation).toBeUndefined();
        return payload;
      }
    );
    const second = lifecycle.run(
      async () => 'C',
      (payload, generation) => {
        sideEffects.push(payload);
        expect(generation).toBeUndefined();
        return payload;
      }
    );

    await expect(second).resolves.toEqual({
      status: 'applied',
      value: 'C',
      generation: undefined,
    });
    resolveFirst('B');
    await expect(first).resolves.toEqual({
      status: 'applied',
      value: 'B',
      generation: undefined,
    });
    expect(sideEffects).toEqual(['C', 'B']);
  });

  it('commits an accepted older tree without consuming a newer pending generation', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const lifecycle = createDevStyleNavigationLifecycle();
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => lifecycle.complete(generation),
    });
    lifecycle.register(registry);

    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    lifecycle.commitTree(0);

    const b = await lifecycle.run(
      async () => 'B',
      (value, generation) => ({ value, generation: generation! })
    );
    expect(b.status).toBe('applied');
    if (b.status !== 'applied') throw new Error('B should be accepted');

    let resolveC!: (value: string) => void;
    const cPromise = lifecycle.run(
      () =>
        new Promise<string>(resolve => {
          resolveC = resolve;
        }),
      (value, generation) => ({ value, generation: generation! })
    );

    registry.publish('/src/B.scss', '.b{display:grid}');
    appendRscLink(document, '/src/B.scss?direct');
    lifecycle.commitTree(b.value.generation);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();

    registry.publish('/src/C.scss', '.c{display:flex}');
    lifecycle.commitTree(b.value.generation);
    resolveC('C');
    const c = await cPromise;
    expect(c.status).toBe('applied');
    if (c.status !== 'applied') throw new Error('C should be accepted');
    appendRscLink(document, '/src/C.scss?direct');
    lifecycle.commitTree(c.value.generation);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/C.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();

    registry.dispose();
    window.close();
  });

  it('aborts a navigation whose registry loads after the generation starts', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const lifecycle = createDevStyleNavigationLifecycle();
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => lifecycle.complete(generation),
    });

    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0);

    await expect(
      lifecycle.run(
        async () => {
          lifecycle.register(registry);
          appendRscLink(document, '/src/B.scss?direct');
          registry.publish('/src/B.scss', '.b{display:grid}');
          throw new Error('RSC navigation aborted');
        },
        payload => payload
      )
    ).rejects.toThrow('RSC navigation aborted');

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();

    registry.dispose();
    window.close();
  });
});
