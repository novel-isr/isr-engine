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
  it('commits generation-zero Server CSS through the real prepare and commit sequence', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const lifecycle = createDevStyleNavigationLifecycle();
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => {
        committed.push(generation);
        lifecycle.complete(generation);
      },
    });
    lifecycle.register(registry);
    const bootstrap = document.createElement('link');
    bootstrap.rel = 'stylesheet';
    bootstrap.href = '/src/ServerOnly.scss?direct';
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    document.head.appendChild(bootstrap);

    await lifecycle.prepareTree(0, ['/src/ServerOnly.scss']);
    expect(bootstrap.isConnected).toBe(true);
    expect(bootstrap.media).toBe('');

    lifecycle.commitTree(0, ['/src/ServerOnly.scss']);
    expect(committed).toEqual([0]);
    expect(bootstrap.isConnected).toBe(true);
    expect(bootstrap.media).toBe('');

    registry.publish('/src/ServerOnly.scss', '.server-only{color:green}');
    registry.beginUpdate();
    registry.publish('/src/ServerOnly.scss', '.server-only{color:blue}');
    registry.commitUpdate(['/src/ServerOnly.scss']);
    expect(bootstrap.isConnected).toBe(false);
    expect(
      document.querySelector<HTMLStyleElement>(
        'style[data-novel-isr-dev-style="/src/ServerOnly.scss"]'
      )?.textContent
    ).toContain('blue');

    registry.beginRscUpdate(1);
    await lifecycle.prepareTree(1, []);
    lifecycle.commitTree(1, []);
    expect(committed).toEqual([0, 1]);
    expect(document.querySelector('style[data-novel-isr-dev-style]')).toBeNull();

    registry.dispose();
    window.close();
  });

  it('fails before scheduling when declared styles have no registry owner', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();

    await expect(lifecycle.prepareTree(1, ['/src/A.scss'])).rejects.toThrow(
      /stylesheet registry is unavailable/i
    );
  });

  it('waits for exact generation style preparation before payload side effects', async () => {
    const lifecycle = createDevStyleNavigationLifecycle();
    const events: string[] = [];
    let resolveStyles!: () => void;
    const stylesReady = new Promise<void>(resolve => {
      resolveStyles = resolve;
    });

    const navigation = lifecycle.run(
      async () => 'B',
      value => {
        events.push(`apply:${value}`);
        return value;
      },
      async (_value, generation) => {
        events.push(`prepare:${generation}`);
        await stylesReady;
        events.push(`ready:${generation}`);
      }
    );

    await Promise.resolve();
    expect(events).toEqual(['prepare:1']);
    resolveStyles();
    await expect(navigation).resolves.toEqual({ status: 'applied', value: 'B', generation: 1 });
    expect(events).toEqual(['prepare:1', 'ready:1', 'apply:B']);
  });

  it('aborts an older generation still preparing when a newer response is ready', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const lifecycle = createDevStyleNavigationLifecycle();
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => lifecycle.complete(generation),
    });
    lifecycle.register(registry);
    const applied: string[] = [];

    const first = lifecycle.run(
      async () => 'B',
      value => {
        applied.push(value);
        return value;
      },
      (_value, generation) => lifecycle.prepareTree(generation!, ['/src/B.scss'])
    );
    await Promise.resolve();
    expect(document.querySelector('link[rel="preload"][href*="/src/B.scss"]')).not.toBeNull();

    registry.publish('/src/C.scss', '.c{display:flex}');
    await expect(
      lifecycle.run(
        async () => 'C',
        value => {
          applied.push(value);
          return value;
        },
        (_value, generation) => lifecycle.prepareTree(generation!, ['/src/C.scss'])
      )
    ).resolves.toEqual({ status: 'applied', value: 'C', generation: 2 });

    await expect(first).resolves.toEqual({ status: 'superseded', operationValue: 'B' });
    expect(applied).toEqual(['C']);
    expect(document.querySelector('link[rel="preload"][href*="/src/B.scss"]')).toBeNull();
    registry.dispose();
    window.close();
  });

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
      async () => {
        registry.publish('/src/B.scss', '.b{display:grid}');
        return 'B';
      },
      (value, generation) => {
        return { value, generation: generation! };
      },
      (_value, generation) => lifecycle.prepareTree(generation!, ['/src/B.scss'])
    );
    expect(b.status).toBe('applied');
    if (b.status !== 'applied') throw new Error('B should be accepted');

    const c = await lifecycle.run(
      async () => {
        registry.publish('/src/C.scss', '.c{display:flex}');
        return 'C';
      },
      (value, generation) => {
        return { value, generation: generation! };
      },
      (_value, generation) => lifecycle.prepareTree(generation!, ['/src/C.scss'])
    );
    expect(c.status).toBe('applied');
    if (c.status !== 'applied') throw new Error('C should be accepted');

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
