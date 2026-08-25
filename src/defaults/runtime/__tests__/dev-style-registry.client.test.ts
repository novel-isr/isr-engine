import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { createDevStyleRegistry, type DevStyleRegistry } from '../dev-style-registry.client';

interface RegistryFixture {
  document: Document;
  registry: DevStyleRegistry;
  window: Window;
}

const fixtures: RegistryFixture[] = [];

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

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.window.close();
});

describe('development style registry', () => {
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
    registry.publish('/workspace/app/src/Card.scss', '.card { color: green }');

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

  it('does not remove an aborted transport owner still required by a committed or pending set', () => {
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

    expect(committedLink.isConnected).toBe(true);
    expect(sharedLink.isConnected).toBe(true);
  });

  it('removes an aborted generation transport link before payload declarations finish', () => {
    const { document, registry } = createFixture();

    registry.beginRscUpdate(1);
    const link = appendRscLink(document, '/src/Partial.scss?direct', 1);
    registry.abortRscUpdate(1);

    expect(link.isConnected).toBe(false);
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

  it('reclaims a shared aborted owner at the next owning commit', () => {
    const { document, registry } = createFixture();
    const bootstrap = appendRscLink(document, '/src/A.scss?direct');
    bootstrap.dataset.precedence = 'vite-rsc/importer-resources';
    registry.reconcileDocumentStyles(0, ['/src/A.scss']);

    registry.beginRscUpdate(1);
    registry.declareRscStyles(1, ['/src/A.scss']);
    const aborted = appendRscLink(document, '/src/A.scss?direct', 1);
    aborted.dataset.precedence = 'vite-rsc/importer-resources';
    registry.abortRscUpdate(1);

    expect(aborted.isConnected).toBe(true);

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

  it('disposes managed nodes idempotently', () => {
    const { document, registry } = createFixture();

    registry.publish('/src/Card.scss', '.card { color: green }');
    registry.dispose();
    registry.dispose();

    expect(document.querySelector('style[data-novel-isr-dev-style]')).toBeNull();
  });
});
