import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { createDevStyleRegistry, type DevStyleRegistry } from '../dev-style-registry.client';

interface RegistryFixture {
  document: Document;
  registry: DevStyleRegistry;
  window: Window;
}

const fixtures: RegistryFixture[] = [];
const DEV_STYLE_REGISTRY_INSPECT = Symbol.for('novel-isr.dev-style-registry.inspect');

interface GenerationStateSnapshot {
  committedWatermark: number;
  controllers: number[];
  declarations: number[];
  invalidatedRanges: Array<[number, number]>;
  pending: number[];
  preloads: number[];
  prepared: number[];
  preparing: number[];
  promises: number[];
}

function generationState(registry: DevStyleRegistry): GenerationStateSnapshot {
  const inspect = Reflect.get(registry, DEV_STYLE_REGISTRY_INSPECT) as
    | (() => GenerationStateSnapshot)
    | undefined;
  expect(inspect).toBeTypeOf('function');
  return inspect!();
}

function createFixture(markup = ''): RegistryFixture {
  const window = new Window({ url: 'http://localhost:3000/' });
  window.document.head.innerHTML = markup;
  const fixture = {
    document: window.document as unknown as Document,
    registry: createDevStyleRegistry(window.document as unknown as Document),
    window,
  };
  fixtures.push(fixture);
  return fixture;
}

function appendRscLink(document: Document, href: string, generation?: number): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  if (generation === undefined) {
    link.href = href;
  } else {
    const url = new URL(href, document.baseURI);
    url.searchParams.set('__novel_isr_style_generation', String(generation));
    link.href = `${url.pathname}${url.search}`;
  }
  link.dataset.precedence = 'vite-rsc/client-reference';
  document.head.appendChild(link);
  return link;
}

function createPromotedTransportFixture(): RegistryFixture & { promoted: HTMLLinkElement } {
  const fixture = createFixture();
  const { document, registry } = fixture;
  registry.beginRscUpdate(1);
  const promoted = appendRscLink(document, '/src/A.scss?direct', 1);
  promoted.dataset.precedence = 'vite-rsc/importer-resources';
  registry.reconcileDocumentStyles(1, ['/src/A.scss']);

  registry.beginRscUpdate(2);
  registry.declareRscStyles(2, ['/src/A.scss']);
  registry.reconcileDocumentStyles(2, ['/src/A.scss']);

  return { ...fixture, promoted };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.window.close();
});

describe('development style registry', () => {
  it('keeps root and external styles with the same basename in separate cache records', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.root{color:green}');
    registry.publish('/@fs/workspace/package/src/Card.scss', '.external{color:red}');

    const nodes = Array.from(
      document.querySelectorAll<HTMLStyleElement>('style[data-novel-isr-dev-style]')
    );
    expect(nodes.map(node => node.dataset.novelIsrDevStyle)).toEqual([
      '/src/Card.scss',
      '/@fs/workspace/package/src/Card.scss',
    ]);
    expect(nodes.map(node => node.textContent)).toEqual([
      '.root{color:green}',
      '.external{color:red}',
    ]);
  });

  it('installs and updates one managed node before releasing an SSR client-reference link', () => {
    const { document, registry } = createFixture(`
      <link rel="stylesheet" href="/src/Card.scss?direct" data-precedence="vite-rsc/client-reference">
    `);

    registry.publish('/src/Card.scss', '.card { color: green }');
    registry.reconcileDocumentStyles(0, ['/src/Card.scss']);
    expect(
      document.querySelector('style[data-novel-isr-dev-style="/src/Card.scss"]')
    ).not.toBeNull();
    expect(document.querySelector('link[href*="Card.scss"]')).toBeNull();

    const node = document.querySelector('style')!;
    registry.publish('/src/Card.scss', '.card { color: blue }');
    expect(document.querySelector('style')).toBe(node);
    expect(node.textContent).toContain('blue');
  });

  it('keeps the current node connected while prune and republish share an update', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    const node = document.querySelector('style')!;

    registry.beginUpdate();
    registry.prune('/src/Card.scss');
    expect(node.isConnected).toBe(true);
    registry.publish('/src/Card.scss', '.card { color: red }');
    registry.commitUpdate(['/src/Card.scss']);
    expect(node.isConnected).toBe(true);
  });

  it('releases a pruned node after a committed active set excludes it', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    registry.beginUpdate();
    registry.prune('/src/Card.scss');
    registry.commitUpdate(['/src/Other.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style]')).toBeNull();
  });

  it('keeps a pending node when an update commits without an active set', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    const node = document.querySelector('style')!;
    registry.beginUpdate();
    registry.prune('/src/Card.scss');
    registry.commitUpdate();

    expect(document.querySelector('style')).toBe(node);
    expect(node.isConnected).toBe(true);
  });

  it('preserves a pending node when the update aborts', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    const node = document.querySelector('style')!;
    registry.beginUpdate();
    registry.prune('/src/Card.scss');
    registry.abortUpdate();

    expect(document.querySelector('style')).toBe(node);
    expect(node.textContent).toContain('green');
  });

  it('normalizes duplicate publishes to one canonical node', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss?direct&t=42', '.card { color: green }');
    registry.publish('/src/Card.scss?v=43', '.card { color: green }');

    expect(document.querySelectorAll('style[data-novel-isr-dev-style]').length).toBe(1);
    expect(
      document
        .querySelector('style[data-novel-isr-dev-style]')
        ?.getAttribute('data-novel-isr-dev-style')
    ).toBe('/src/Card.scss');
  });

  it('adopts importer-resource links before replacing them with managed CSS', () => {
    const { document, registry } = createFixture(`
      <link rel="stylesheet" href="/src/Card.scss?direct" data-precedence="vite-rsc/importer-resources">
    `);

    registry.reconcileDocumentStyles(0, ['/src/Card.scss']);
    registry.publish('/src/Card.scss', '.card { color: green }');

    expect(document.querySelector('link[href*="Card.scss"]')).toBeNull();
    expect(
      document
        .querySelector('style[data-novel-isr-dev-style]')
        ?.getAttribute('data-novel-isr-dev-style')
    ).toBe('/src/Card.scss');
  });

  it('installs the next committed owner before releasing its RSC link and prior owner', async () => {
    const { document, registry, window } = createFixture();

    registry.publish('/src/A.scss', '.a{display:block}');
    const mutations: string[] = [];
    const observer = new window.MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`insert-style:${node.dataset.novelIsrDevStyle}`);
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof window.HTMLLinkElement) {
            mutations.push(`remove-link:${node.getAttribute('href')}`);
          }
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`remove-style:${node.dataset.novelIsrDevStyle}`);
          }
        }
      }
    });
    observer.observe(document.head, { childList: true });

    registry.beginRscUpdate(1);
    appendRscLink(document, '/src/B.scss?direct');
    registry.publish('/src/B.scss', '.b{display:grid}');
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);
    await window.happyDOM.whenAsyncComplete();
    observer.disconnect();

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();

    const insertB = mutations.indexOf('insert-style:/src/B.scss');
    const removeBLink = mutations.indexOf('remove-link:/src/B.scss?direct');
    const removeA = mutations.indexOf('remove-style:/src/A.scss');
    expect(insertB).toBeGreaterThanOrEqual(0);
    expect(removeBLink).toBeGreaterThan(insertB);
    expect(removeA).toBeGreaterThan(removeBLink);
  });

  it('keeps the committed owner when an RSC update aborts', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/A.scss', '.a{display:block}');
    registry.beginRscUpdate(1);
    registry.prune('/src/A.scss');
    appendRscLink(document, '/src/B.scss?direct');
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);
    registry.abortRscUpdate(1);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
  });

  it('commits an RSC DOM resource set when its managed owners are already active', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/A.scss', '.a{display:block}');
    registry.beginRscUpdate(1);
    registry.publish('/src/B.scss', '.b{display:grid}');
    appendRscLink(document, '/src/B.scss?direct');
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).not.toBeNull();
    expect(document.querySelector('link[href*="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
  });

  it('keeps the committed owner across repeated boundary effects for the same RSC tree', () => {
    const { document, registry } = createFixture();

    registry.beginRscUpdate(0);
    appendRscLink(document, '/src/B.scss?direct');
    registry.publish('/src/B.scss', '.b{display:grid}');
    registry.reconcileDocumentStyles(0, ['/src/B.scss']);
    const owner = document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]');

    registry.reconcileDocumentStyles(0, ['/src/B.scss']);
    registry.reconcileDocumentStyles(0, ['/src/B.scss']);

    expect(owner).not.toBeNull();
    expect(owner?.isConnected).toBe(true);
    expect(document.querySelectorAll('style[data-novel-isr-dev-style="/src/B.scss"]')).toHaveLength(
      1
    );
  });

  it('removes only an aborted generation transport link while a newer generation stays pending', () => {
    const { document, registry } = createFixture();

    registry.beginRscUpdate(0);
    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    appendRscLink(document, '/src/B.scss?direct', 1);
    registry.publish('/src/B.scss', '.b{display:grid}');

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/C.scss']);
    const cLink = appendRscLink(document, '/src/C.scss?direct', 2);

    registry.abortRscUpdate(1);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('link[href*="/src/B.scss"]')).toBeNull();
    expect(cLink.isConnected).toBe(true);

    registry.publish('/src/B.scss', '.b{display:grid}');
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('link[href*="/src/B.scss"]')).toBeNull();

    registry.publish('/src/C.scss', '.c{display:flex}');
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/C.scss"]')).not.toBeNull();
  });

  it('removes every exact transport owner for an aborted generation', () => {
    const { document, registry } = createFixture();

    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss', '/src/Shared.scss']);
    const committedLink = appendRscLink(document, '/src/A.scss?direct', 1);
    const sharedLink = appendRscLink(document, '/src/Shared.scss?direct', 1);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/Shared.scss']);
    registry.abortRscUpdate(1);

    expect(committedLink.isConnected).toBe(false);
    expect(sharedLink.isConnected).toBe(false);
  });

  it('removes an aborted generation transport link before payload declarations finish', () => {
    const { document, registry } = createFixture();

    registry.beginRscUpdate(1);
    const link = appendRscLink(document, '/src/Partial.scss?direct', 1);
    registry.abortRscUpdate(1);

    expect(link.isConnected).toBe(false);
  });

  it('invalidates a skipped older generation as part of the newer commit', () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{display:block}');

    registry.beginRscUpdate(1);
    const skipped = appendRscLink(document, '/src/B.scss?direct', 1);
    skipped.dataset.precedence = 'vite-rsc/importer-resources';

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/C.scss']);
    registry.publish('/src/C.scss', '.c{display:grid}');
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    expect(skipped.isConnected).toBe(false);

    registry.abortRscUpdate(1);

    expect(skipped.isConnected).toBe(false);
  });

  it('commits the exact visible generation without consuming a newer pending generation', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });

    appendRscLink(document, '/src/A.scss?direct');
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.publish('/src/B.scss', '.b{display:grid}');
    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/C.scss']);
    registry.publish('/src/C.scss', '.c{display:flex}');

    const bLink = appendRscLink(document, '/src/B.scss?direct', 1);
    const cLink = appendRscLink(document, '/src/C.scss?direct', 2);
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(committed).toEqual([0, 1]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLStyleElement>('style[data-novel-isr-dev-style]')
      ).map(node => node.dataset.novelIsrDevStyle)
    ).toEqual(['/src/B.scss']);
    expect(bLink.isConnected).toBe(false);
    expect(cLink.isConnected).toBe(true);

    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(committed).toEqual([0, 1, 2]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLStyleElement>('style[data-novel-isr-dev-style]')
      ).map(node => node.dataset.novelIsrDevStyle)
    ).toEqual(['/src/C.scss']);
  });

  it('does not promote an aborted generation when its CSS publishes late', () => {
    const { document, registry } = createFixture();

    registry.beginRscUpdate(0);
    registry.declareRscStyles(0, ['/src/A.scss']);
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.abortRscUpdate(1);
    registry.publish('/src/B.scss', '.b{display:grid}');

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/C.scss']);
    registry.publish('/src/C.scss', '.c{display:flex}');
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);

    expect(
      Array.from(
        document.querySelectorAll<HTMLStyleElement>('style[data-novel-isr-dev-style]')
      ).map(node => node.dataset.novelIsrDevStyle)
    ).toEqual(['/src/C.scss']);
  });

  it('ignores a late commit from an invalidated generation even when its bytes are cached', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.publish('/src/B.scss', '.b{display:grid}');
    registry.abortRscUpdate(1);
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(committed).toEqual([0]);
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
  });

  it('treats a committed importer-resource link as an active owner', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/A.scss', '.a{display:block}');
    registry.beginRscUpdate(1);
    const link = appendRscLink(document, '/src/B.scss?direct', 1);
    link.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(link.isConnected).toBe(true);
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
  });

  it('converges a shared importer to one owner across generations 0 through 3', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';

    registry.beginRscUpdate(0);
    registry.declareRscStyles(0, ['/src/A.scss']);
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const generation1 = appendRscLink(document, '/src/A.scss?direct', 1);
    generation1.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(1, ['/src/A.scss']);

    expect(bootstrap.isConnected).toBe(false);
    expect(generation1.isConnected).toBe(true);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    const generation2 = appendRscLink(document, '/src/A.scss?direct', 2);
    generation2.dataset.precedence = 'vite-rsc/importer-resources';
    registry.beginRscUpdate(3);
    registry.declareRscStyles(3, ['/src/A.scss']);
    const generation3 = appendRscLink(document, '/src/A.scss?direct', 3);
    generation3.dataset.precedence = 'vite-rsc/importer-resources';

    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(generation1.isConnected).toBe(false);
    expect(generation2.isConnected).toBe(true);
    expect(generation3.isConnected).toBe(true);

    registry.reconcileDocumentStyles(3, ['/src/A.scss']);

    expect(generation2.isConnected).toBe(false);
    expect(generation3.isConnected).toBe(true);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);
  });

  it('keeps the latest available importer owner when the committed token is absent', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const generation1 = appendRscLink(document, '/src/A.scss?direct', 1);
    generation1.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(1, ['/src/A.scss']);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(committed).toEqual([0, 1, 2]);
    expect(bootstrap.isConnected).toBe(false);
    expect(generation1.isConnected).toBe(true);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);
  });

  it.each([
    ['begin', (registry: DevStyleRegistry) => registry.beginRscUpdate(1)],
    ['declare', (registry: DevStyleRegistry) => registry.declareRscStyles(1, ['/src/A.scss'])],
    ['prepare', (registry: DevStyleRegistry) => registry.prepareRscStyles(1, ['/src/A.scss'])],
    [
      'reconcile',
      (registry: DevStyleRegistry) => registry.reconcileDocumentStyles(1, ['/src/A.scss']),
    ],
    ['abort', (registry: DevStyleRegistry) => registry.abortRscUpdate(1)],
  ])(
    'protects a promoted committed transport across stale %s lifecycle touches',
    async (_name, touch) => {
      const { document, promoted, registry } = createPromotedTransportFixture();
      let committedOwnerRemoved = false;
      const removePromoted = promoted.remove.bind(promoted);
      promoted.remove = () => {
        committedOwnerRemoved = true;
        removePromoted();
      };

      await touch(registry);

      expect(promoted.isConnected).toBe(true);
      expect(committedOwnerRemoved).toBe(false);
      expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);

      const duplicate = appendRscLink(document, '/src/A.scss?direct', 1);
      duplicate.dataset.precedence = 'vite-rsc/importer-resources';
      duplicate.media = 'not all';
      await touch(registry);

      expect(promoted.isConnected).toBe(true);
      expect(committedOwnerRemoved).toBe(false);
      expect(duplicate.isConnected).toBe(false);
      expect(duplicate.media).toBe('not all');
      expect(Array.from(document.querySelectorAll('link[href*="/src/A.scss"]'))).toEqual([
        promoted,
      ]);
    }
  );

  it('keeps a promoted generation-zero transport eligible across later fallback commits', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    for (const generation of [2, 3]) {
      registry.beginRscUpdate(generation);
      registry.declareRscStyles(generation, ['/src/A.scss']);
      registry.reconcileDocumentStyles(generation, ['/src/A.scss']);
    }

    expect(generationState(registry).committedWatermark).toBe(3);
    expect(bootstrap.isConnected).toBe(true);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);
  });

  it('activates a new exact transport before releasing the promoted committed owner', () => {
    const { document, promoted, registry } = createPromotedTransportFixture();
    const mutations: string[] = [];
    const exact = appendRscLink(document, '/src/A.scss?direct', 3);
    exact.dataset.precedence = 'vite-rsc/importer-resources';
    exact.media = 'not all';
    const removeExactAttribute = exact.removeAttribute.bind(exact);
    exact.removeAttribute = name => {
      if (name === 'media') mutations.push('activate-exact');
      removeExactAttribute(name);
    };
    const removePromoted = promoted.remove.bind(promoted);
    promoted.remove = () => {
      mutations.push('remove-promoted');
      removePromoted();
    };

    registry.beginRscUpdate(3);
    registry.declareRscStyles(3, ['/src/A.scss']);
    registry.reconcileDocumentStyles(3, ['/src/A.scss']);

    expect(exact.isConnected).toBe(true);
    expect(exact.media).toBe('');
    expect(promoted.isConnected).toBe(false);
    expect(mutations.indexOf('activate-exact')).toBeGreaterThanOrEqual(0);
    expect(mutations.indexOf('remove-promoted')).toBeGreaterThan(
      mutations.indexOf('activate-exact')
    );

    registry.reconcileDocumentStyles(3, ['/src/A.scss']);
    expect(Array.from(document.querySelectorAll('link[href*="/src/A.scss"]'))).toEqual([exact]);
  });

  it('installs managed CSS before releasing the promoted committed owner', async () => {
    const { document, promoted, registry, window } = createPromotedTransportFixture();
    const mutations: string[] = [];
    const observer = new window.MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof window.HTMLStyleElement) mutations.push('insert-managed');
        }
        for (const node of record.removedNodes) {
          if (node === promoted) mutations.push('remove-promoted');
        }
      }
    });
    observer.observe(document.head, { childList: true });

    registry.publish('/src/A.scss', '.a{color:green}');
    await window.happyDOM.whenAsyncComplete();
    observer.disconnect();

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(promoted.isConnected).toBe(false);
    expect(mutations.indexOf('insert-managed')).toBeGreaterThanOrEqual(0);
    expect(mutations.indexOf('remove-promoted')).toBeGreaterThan(
      mutations.indexOf('insert-managed')
    );
  });

  it('clears promoted transport ownership when a route removes the stylesheet', () => {
    const { document, promoted, registry } = createPromotedTransportFixture();

    registry.beginRscUpdate(3);
    registry.declareRscStyles(3, []);
    registry.reconcileDocumentStyles(3, []);
    registry.reconcileDocumentStyles(3, []);

    expect(promoted.isConnected).toBe(false);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(0);

    const late = appendRscLink(document, '/src/A.scss?direct', 1);
    late.dataset.precedence = 'vite-rsc/importer-resources';
    registry.abortRscUpdate(1);
    expect(late.isConnected).toBe(false);
  });

  it('clears promoted transport identity when the registry is disposed', () => {
    const { promoted, registry } = createPromotedTransportFixture();

    registry.dispose();
    registry.abortRscUpdate(1);

    expect(promoted.isConnected).toBe(false);
  });

  it('keeps only the latest importer when one generation renders duplicate owners', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const first = appendRscLink(document, '/src/A.scss?direct', 1);
    first.dataset.precedence = 'vite-rsc/importer-resources';
    const latest = appendRscLink(document, '/src/A.scss?direct', 1);
    latest.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(1, ['/src/A.scss']);

    expect(bootstrap.isConnected).toBe(false);
    expect(first.isConnected).toBe(false);
    expect(latest.isConnected).toBe(true);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);
  });

  it('removes a shared aborted owner immediately when its committed owner is valid', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const aborted = appendRscLink(document, '/src/A.scss?direct', 1);
    aborted.dataset.precedence = 'vite-rsc/importer-resources';
    registry.abortRscUpdate(1);

    expect(aborted.isConnected).toBe(false);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    const generation2 = appendRscLink(document, '/src/A.scss?direct', 2);
    generation2.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(bootstrap.isConnected).toBe(false);
    expect(aborted.isConnected).toBe(false);
    expect(generation2.isConnected).toBe(true);
    expect(document.querySelectorAll('link[href*="/src/A.scss"]')).toHaveLength(1);
  });

  it('never promotes an aborted shared token when a valid committed fallback exists', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    const generation0 = appendRscLink(document, '/src/A.scss?direct');
    generation0.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const aborted = appendRscLink(document, '/src/A.scss?direct', 1);
    aborted.dataset.precedence = 'vite-rsc/importer-resources';
    registry.abortRscUpdate(1);

    expect(generation0.isConnected).toBe(true);
    expect(aborted.isConnected).toBe(false);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(committed).toEqual([0, 2]);
    expect(generation0.isConnected).toBe(true);
    expect(aborted.isConnected).toBe(false);
  });

  it('removes an aborted last transport without accepting it as a committed fallback', () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    const generation0 = appendRscLink(document, '/src/A.scss?direct');
    generation0.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);
    generation0.remove();

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const aborted = appendRscLink(document, '/src/A.scss?direct', 1);
    aborted.dataset.precedence = 'vite-rsc/importer-resources';
    registry.abortRscUpdate(1);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(committed).toEqual([0]);
    expect(aborted.isConnected).toBe(false);

    const generation2 = appendRscLink(document, '/src/A.scss?direct', 2);
    generation2.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(committed).toEqual([0, 2]);
    expect(aborted.isConnected).toBe(false);
    expect(generation2.isConnected).toBe(true);
  });

  it('removes every committed transport owner after managed CSS is ready but preserves the future', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const generation1 = appendRscLink(document, '/src/A.scss?direct', 1);
    generation1.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(1, ['/src/A.scss']);

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    const generation2 = appendRscLink(document, '/src/A.scss?direct', 2);
    generation2.dataset.precedence = 'vite-rsc/importer-resources';
    registry.beginRscUpdate(3);
    registry.declareRscStyles(3, ['/src/A.scss']);
    const generation3 = appendRscLink(document, '/src/A.scss?direct', 3);
    generation3.dataset.precedence = 'vite-rsc/importer-resources';

    registry.publish('/src/A.scss', '.a{color:green}');

    expect(bootstrap.isConnected).toBe(false);
    expect(generation1.isConnected).toBe(false);
    expect(generation2.isConnected).toBe(true);
    expect(generation3.isConnected).toBe(true);

    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(generation2.isConnected).toBe(false);
    expect(generation3.isConnected).toBe(true);
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
  });

  it('retains inactive CSS bytes across A to B to A without a client module republish', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    registry.publish('/src/A.scss', '.a{color:green}');

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.publish('/src/B.scss', '.b{color:blue}');
    registry.beginRscUpdate(2);
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
    const bNode = document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')!;
    expect(bNode.textContent).toContain('blue');

    const mutations: string[] = [];
    const observer = new window.MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`insert:${node.dataset.novelIsrDevStyle}`);
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`remove:${node.dataset.novelIsrDevStyle}`);
          }
        }
      }
    });
    observer.observe(document.head, { childList: true });

    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);
    await window.happyDOM.whenAsyncComplete();
    observer.disconnect();

    const aNode = document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]');
    expect(aNode?.textContent).toContain('green');
    expect(bNode.isConnected).toBe(false);
    expect(committed).toEqual([1, 2]);
    expect(mutations.indexOf('insert:/src/A.scss')).toBeGreaterThanOrEqual(0);
    expect(mutations.indexOf('remove:/src/B.scss')).toBeGreaterThan(
      mutations.indexOf('insert:/src/A.scss')
    );
  });

  it('preloads a pending generation without applying it and refuses commit until ready', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });

    registry.beginRscUpdate(1);
    const preparation = registry.prepareRscStyles(1, ['/src/B.scss']);
    const preload = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][as="style"][href*="/src/B.scss"]'
    );

    expect(preload).not.toBeNull();
    expect(document.querySelector('link[rel="stylesheet"][href*="/src/B.scss"]')).toBeNull();
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);
    expect(committed).toEqual([]);

    preload!.dispatchEvent(new window.Event('load'));
    await preparation;
    const owner = appendRscLink(document, '/src/B.scss?direct', 1);
    owner.dataset.precedence = 'vite-rsc/importer-resources';
    owner.media = 'not all';
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(owner.media).toBe('');
    expect(committed).toEqual([1]);
    expect(preload!.isConnected).toBe(false);
  });

  it('finalizes every older uncommitted prepared generation when a newer tree commits', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    await registry.prepareRscStyles(0, ['/src/A.scss']);
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const preparationB = registry.prepareRscStyles(1, ['/src/B.scss']);
    const preloadB = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][href*="/src/B.scss"]'
    )!;
    preloadB.dispatchEvent(new window.Event('load'));
    await preparationB;
    const transportB = appendRscLink(document, '/src/B.scss?direct', 1);
    transportB.dataset.precedence = 'vite-rsc/importer-resources';
    transportB.media = 'not all';

    registry.beginRscUpdate(2);
    registry.publish('/src/C.scss', '.c{display:grid}');
    await registry.prepareRscStyles(2, ['/src/C.scss']);

    registry.beginRscUpdate(3);
    const preparationD = registry.prepareRscStyles(3, ['/src/D.scss']);
    const preloadD = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][href*="/src/D.scss"]'
    )!;
    const transportD = appendRscLink(document, '/src/D.scss?direct', 3);
    transportD.dataset.precedence = 'vite-rsc/importer-resources';
    transportD.media = 'not all';

    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    registry.abortRscUpdate(1);
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);
    await registry.prepareRscStyles(1, ['/src/B.scss']);

    expect(committed).toEqual([0, 2]);
    expect(preloadB.isConnected).toBe(false);
    expect(transportB.isConnected).toBe(false);
    expect(document.querySelector('link[rel="preload"][href*="/src/B.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/C.scss"]')).not.toBeNull();
    expect(preloadD.isConnected).toBe(true);
    expect(transportD.isConnected).toBe(true);
    expect(transportD.media).toBe('not all');
    expect(generationState(registry)).toEqual({
      committedWatermark: 2,
      controllers: [3],
      declarations: [3],
      invalidatedRanges: [],
      pending: [3],
      preloads: [3],
      prepared: [],
      preparing: [3],
      promises: [3],
    });

    registry.abortRscUpdate(3);
    await expect(preparationD).rejects.toThrow(/generation 3 was aborted/i);
    expect(generationState(registry)).toEqual({
      committedWatermark: 2,
      controllers: [],
      declarations: [],
      invalidatedRanges: [[3, 3]],
      pending: [],
      preloads: [],
      prepared: [],
      preparing: [],
      promises: [],
    });
  });

  it('bounds consecutive invalid generations as ranges and clears them at commit', async () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    for (let generation = 1; generation <= 64; generation += 1) {
      registry.beginRscUpdate(generation);
      registry.abortRscUpdate(generation);
    }

    expect(generationState(registry)).toEqual({
      committedWatermark: 0,
      controllers: [],
      declarations: [],
      invalidatedRanges: [[1, 64]],
      pending: [],
      preloads: [],
      prepared: [],
      preparing: [],
      promises: [],
    });

    registry.beginRscUpdate(65);
    registry.publish('/src/Z.scss', '.z{display:grid}');
    await registry.prepareRscStyles(65, ['/src/Z.scss']);
    registry.reconcileDocumentStyles(65, ['/src/Z.scss']);

    expect(generationState(registry)).toEqual({
      committedWatermark: 65,
      controllers: [],
      declarations: [],
      invalidatedRanges: [],
      pending: [],
      preloads: [],
      prepared: [],
      preparing: [],
      promises: [],
    });
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/Z.scss"]')).not.toBeNull();
  });

  it('removes an undeclared invalid transport that arrives before a newer commit', async () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.abortRscUpdate(1);
    const late = appendRscLink(document, '/src/Unknown.scss?direct', 1);
    late.dataset.precedence = 'vite-rsc/importer-resources';
    late.media = 'not all';

    registry.beginRscUpdate(2);
    registry.publish('/src/C.scss', '.c{display:grid}');
    await registry.prepareRscStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);

    expect(late.isConnected).toBe(false);
    expect(generationState(registry).invalidatedRanges).toEqual([]);
  });

  it('aborts an older in-flight preparation when a newer tree commits', async () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const preparationB = registry.prepareRscStyles(1, ['/src/B.scss']);
    const preloadB = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][href*="/src/B.scss"]'
    )!;
    const transportB = appendRscLink(document, '/src/B.scss?direct', 1);
    transportB.dataset.precedence = 'vite-rsc/importer-resources';
    transportB.media = 'not all';

    registry.beginRscUpdate(2);
    registry.publish('/src/C.scss', '.c{display:grid}');
    await registry.prepareRscStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);

    await expect(preparationB).rejects.toThrow(/generation 1 was aborted/i);
    expect(preloadB.isConnected).toBe(false);
    expect(transportB.isConnected).toBe(false);
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/C.scss"]')).not.toBeNull();
  });

  it('reclaims late stale transport at every public generation lifecycle touch', async () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{display:block}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const preparationB = registry.prepareRscStyles(1, ['/src/B.scss']);
    registry.beginRscUpdate(2);
    registry.publish('/src/C.scss', '.c{display:grid}');
    await registry.prepareRscStyles(2, ['/src/C.scss']);
    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    await expect(preparationB).rejects.toThrow(/generation 1 was aborted/i);

    const assertTouchReclaimsWithoutActivation = async (
      touch: () => void | Promise<void>
    ): Promise<void> => {
      const late = appendRscLink(document, '/src/B.scss?direct', 1);
      late.dataset.precedence = 'vite-rsc/importer-resources';
      late.media = 'not all';
      let activated = false;
      const removeAttribute = late.removeAttribute.bind(late);
      late.removeAttribute = name => {
        if (name === 'media') activated = true;
        removeAttribute(name);
      };

      await touch();

      expect(late.isConnected).toBe(false);
      expect(activated).toBe(false);
      expect(document.querySelector('link[rel="preload"][href*="/src/B.scss"]')).toBeNull();
    };

    await assertTouchReclaimsWithoutActivation(() => registry.beginRscUpdate(1));
    await assertTouchReclaimsWithoutActivation(() => registry.declareRscStyles(1, ['/src/B.scss']));
    await assertTouchReclaimsWithoutActivation(() => registry.prepareRscStyles(1, ['/src/B.scss']));
    await assertTouchReclaimsWithoutActivation(() =>
      registry.reconcileDocumentStyles(1, ['/src/B.scss'])
    );
    await assertTouchReclaimsWithoutActivation(() => registry.abortRscUpdate(1));

    const duplicateCurrent = appendRscLink(document, '/src/C.scss?direct', 2);
    duplicateCurrent.dataset.precedence = 'vite-rsc/importer-resources';
    duplicateCurrent.media = 'not all';
    await registry.prepareRscStyles(2, ['/src/C.scss']);
    expect(duplicateCurrent.isConnected).toBe(false);

    registry.reconcileDocumentStyles(2, ['/src/C.scss']);
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/C.scss"]')).not.toBeNull();
  });

  it('requires the exact prepared generation owner instead of activating an older fallback', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const committed: number[] = [];
    const registry = createDevStyleRegistry(document, {
      onRscCommit: generation => committed.push(generation),
    });
    fixtures.push({ document, registry, window });
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    const preparation = registry.prepareRscStyles(1, ['/src/A.scss']);
    const preload = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][as="style"][href*="/src/A.scss"]'
    )!;
    preload.dispatchEvent(new window.Event('load'));
    await preparation;

    registry.reconcileDocumentStyles(1, ['/src/A.scss']);
    expect(committed).toEqual([0]);
    expect(bootstrap.isConnected).toBe(true);

    const exact = appendRscLink(document, '/src/A.scss?direct', 1);
    exact.dataset.precedence = 'vite-rsc/importer-resources';
    exact.media = 'not all';
    const mutations: string[] = [];
    const removeExactAttribute = exact.removeAttribute.bind(exact);
    exact.removeAttribute = name => {
      if (name === 'media') mutations.push('activate-exact');
      removeExactAttribute(name);
    };
    const removeBootstrap = bootstrap.remove.bind(bootstrap);
    bootstrap.remove = () => {
      mutations.push('remove-bootstrap');
      removeBootstrap();
    };
    registry.reconcileDocumentStyles(1, ['/src/A.scss']);

    expect(committed).toEqual([0, 1]);
    expect(exact.media).toBe('');
    expect(exact.isConnected).toBe(true);
    expect(bootstrap.isConnected).toBe(false);
    expect(mutations.indexOf('activate-exact')).toBeGreaterThanOrEqual(0);
    expect(mutations.indexOf('remove-bootstrap')).toBeGreaterThan(
      mutations.indexOf('activate-exact')
    );
  });

  it('keeps future transport non-applying and swaps cached A after B with no zero owner', async () => {
    const window = new Window({ url: 'http://localhost:3000/' });
    const document = window.document as unknown as Document;
    const registry = createDevStyleRegistry(document);
    fixtures.push({ document, registry, window });

    registry.publish('/src/A.scss', '.a{color:green}');
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.publish('/src/B.scss', '.b{color:blue}');
    await registry.prepareRscStyles(1, ['/src/B.scss']);

    registry.beginRscUpdate(2);
    await registry.prepareRscStyles(2, ['/src/A.scss']);
    const futureA = appendRscLink(document, '/src/A.scss?direct', 2);
    futureA.dataset.precedence = 'vite-rsc/importer-resources';
    futureA.media = 'not all';

    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).not.toBeNull();
    expect(futureA.isConnected).toBe(true);
    expect(futureA.media).toBe('not all');

    const mutations: string[] = [];
    const observer = new window.MutationObserver(records => {
      for (const mutation of records) {
        if (mutation.type === 'attributes' && mutation.target === futureA) {
          mutations.push(`activate:${futureA.media}`);
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`insert:${node.dataset.novelIsrDevStyle}`);
          }
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof window.HTMLStyleElement) {
            mutations.push(`remove:${node.dataset.novelIsrDevStyle}`);
          }
        }
      }
    });
    observer.observe(document.head, {
      childList: true,
      attributes: true,
      attributeFilter: ['media'],
    });

    registry.reconcileDocumentStyles(2, ['/src/A.scss']);
    await window.happyDOM.whenAsyncComplete();
    observer.disconnect();

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).not.toBeNull();
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
    expect(futureA.isConnected).toBe(false);
    expect(mutations.indexOf('insert:/src/A.scss')).toBeGreaterThanOrEqual(0);
    expect(mutations.indexOf('remove:/src/B.scss')).toBeGreaterThan(
      mutations.indexOf('insert:/src/A.scss')
    );
  });

  it('aborts a pending preload without activating its stylesheet owner', async () => {
    const { document, registry, window } = createFixture();
    registry.beginRscUpdate(1);
    const preparation = registry.prepareRscStyles(1, ['/src/B.scss']);
    const rejected = expect(preparation).rejects.toThrow(/aborted/i);
    const owner = appendRscLink(document, '/src/B.scss?direct', 1);
    owner.dataset.precedence = 'vite-rsc/importer-resources';
    owner.media = 'not all';

    registry.abortRscUpdate(1);

    await rejected;
    expect(owner.isConnected).toBe(false);
    expect(owner.media).toBe('not all');
    expect(document.querySelector('link[rel="preload"][href*="/src/B.scss"]')).toBeNull();
    window.happyDOM.cancelAsync();
  });

  it('keeps released CSS detached and uses republished bytes on its next activation', () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{color:green}');
    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.publish('/src/B.scss', '.b{color:blue}');
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);

    registry.publish('/src/A.scss', '.a{color:red}');

    expect(document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')).toBeNull();
    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(
      document.querySelector('style[data-novel-isr-dev-style="/src/A.scss"]')?.textContent
    ).toContain('red');
    expect(document.querySelector('style[data-novel-isr-dev-style="/src/B.scss"]')).toBeNull();
  });

  it('clears retained CSS bytes when the registry is disposed', () => {
    const { document, registry } = createFixture();
    registry.publish('/src/A.scss', '.a{color:green}');
    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/B.scss']);
    registry.publish('/src/B.scss', '.b{color:blue}');
    registry.reconcileDocumentStyles(1, ['/src/B.scss']);
    registry.dispose();

    registry.beginRscUpdate(2);
    registry.declareRscStyles(2, ['/src/A.scss']);
    registry.reconcileDocumentStyles(2, ['/src/A.scss']);

    expect(document.querySelector('style[data-novel-isr-dev-style]')).toBeNull();
  });

  it('disposes managed nodes idempotently', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    registry.dispose();
    registry.dispose();

    expect(document.querySelector('style[data-novel-isr-dev-style]')).toBeNull();
  });
});
