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
  it('assigns the generation before transport starts and leaves disabled transport untouched', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    let developmentGeneration: number | undefined;
    await lifecycle.run(
      async generation => {
        developmentGeneration = generation;
        return 'B';
      },
      value => value
    );

    const production = createDevStyleNavigationLifecycle({ enabled: false });
    let productionGeneration: number | undefined = 99;
    await production.run(
      async generation => {
        productionGeneration = generation;
        return 'B';
      },
      value => value
    );

    expect(developmentGeneration).toBe(1);
    expect(productionGeneration).toBeUndefined();
  });

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

    await expect(first).resolves.toEqual({ status: 'superseded', operationValue: 'B' });
    expect(sideEffects).toEqual(['url:C', 'i18n:C', 'seo:C', 'payload:C']);
  });

  it('silences a stale failure after a newer generation wins but preserves a current failure', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    let rejectFirst!: (error: Error) => void;
    const first = lifecycle.run(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      value => value
    );
    await lifecycle.run(
      async () => 'C',
      value => value
    );

    rejectFirst(new Error('stale B failed'));

    await expect(first).resolves.toEqual({ status: 'superseded' });
    await expect(
      lifecycle.run(
        async () => {
          throw new Error('current D failed');
        },
        value => value
      )
    ).rejects.toThrow('current D failed');
  });

  it('retains a stale Server Action result while suppressing its UI tree application', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    const appliedTrees: string[] = [];
    let resolveFirst!: (value: { tree: string; data: string }) => void;
    const first = lifecycle.run(
      () =>
        new Promise<{ tree: string; data: string }>(resolve => {
          resolveFirst = resolve;
        }),
      value => {
        appliedTrees.push(value.tree);
        return value;
      }
    );
    await lifecycle.run(
      async () => ({ tree: 'C', data: 'action-C' }),
      value => {
        appliedTrees.push(value.tree);
        return value;
      }
    );

    resolveFirst({ tree: 'B', data: 'action-B' });
    const result = await first;

    expect(result).toEqual({
      status: 'superseded',
      operationValue: { tree: 'B', data: 'action-B' },
    });
    expect(result.status === 'superseded' && result.operationValue?.data).toBe('action-B');
    expect(appliedTrees).toEqual(['C']);
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
    lifecycle.prepareTree(0, ['/src/A.scss']);
    lifecycle.commitTree(0, ['/src/A.scss']);

    const b = await lifecycle.run(
      async () => 'B',
      (value, generation) => {
        lifecycle.prepareTree(generation!, ['/src/B.scss']);
        return { value, generation: generation! };
      }
    );
    expect(b.status).toBe('applied');
    if (b.status !== 'applied') throw new Error('B should be accepted');

    const c = await lifecycle.run(
      async () => 'C',
      (value, generation) => {
        lifecycle.prepareTree(generation!, ['/src/C.scss']);
        return { value, generation: generation! };
      }
    );
    expect(c.status).toBe('applied');
    if (c.status !== 'applied') throw new Error('C should be accepted');

    registry.publish('/src/B.scss', '.b{display:grid}');
    registry.publish('/src/C.scss', '.c{display:flex}');
    appendRscLink(document, '/src/B.scss?direct');
    appendRscLink(document, '/src/C.scss?direct');
    lifecycle.commitTree(b.value.generation, ['/src/B.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();

    lifecycle.commitTree(c.value.generation, ['/src/C.scss']);

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
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

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
