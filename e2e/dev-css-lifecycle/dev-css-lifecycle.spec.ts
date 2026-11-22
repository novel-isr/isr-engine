import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterAll, beforeAll, expect } from 'vitest';
import { browserTest, interceptRequests, startBrowserServer } from '../browser';
import {
  DocumentRequestTracker,
  isExpectedRscCancellation,
  type BrowserRequestFailure,
} from './request-diagnostics';

type RouteName = 'home' | 'article' | 'server';

interface StyleFrame {
  route: RouteName;
  ready: string;
  color: string;
  ownerCount: number;
  at: number;
}

interface OwnerEvent {
  route: RouteName;
  ownerCount: number;
  owners: Array<{ id: string; kind: string }>;
  at: number;
}

interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: BrowserRequestFailure[];
  allowedFailurePatterns: RegExp[];
}

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const homeStylePath = path.join(fixtureRoot, 'src/styles/Home.module.scss');
const homeViewPath = path.join(fixtureRoot, 'src/components/HomeView.client.tsx');
const homeSentinel = '[data-style-sentinel="home"]';
const generationHeader = 'x-isr-engine-dev-style-generation';
const expectedColors: Record<RouteName, string[]> = {
  home: ['rgb(1, 101, 51)'],
  article: ['rgb(91, 41, 171)'],
  server: ['rgb(161, 71, 21)'],
};

let server: Awaited<ReturnType<typeof startBrowserServer>>;
beforeAll(async () => {
  server = await startBrowserServer('dev-css-lifecycle');
});
afterAll(async () => {
  await server?.close();
});

const url = (pathname: string) => new URL(pathname, server.origin).href;
const test = browserTest.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ page }, use) => {
      const diagnostics = createDiagnostics(page);
      await installTemporalObserver(page);
      await use(diagnostics);
      assertCleanDiagnostics(diagnostics);
    },
    { auto: true },
  ],
});

test('cold SSR applies direct and transitive client CSS before the client entry starts', async ({
  page,
}) => {
  await interceptRequests(page, async request => {
    if (!/virtual:vite-rsc\/entry-browser/.test(request.url())) return;
    await request.respond({
      status: 200,
      contentType: 'text/javascript',
      body: 'export {};',
    });
  });

  await page.goto(url('/'));
  await page.waitForSelector(homeSentinel, { visible: true });
  await expect.poll(() => readStyle(page, homeSentinel, '--route-style-ready')).toBe('home');
  const nested = '[data-transient-panel="primary"]';
  await page.waitForSelector(nested, { visible: true });
  await expect.poll(() => readStyle(page, nested, '--transient-style-ready')).toBe('primary');

  await expect.poll(() => countElements(page, 'style[data-isr-engine-dev-style]')).toBe(0);
  const stylesheet = 'link[rel="stylesheet"][data-precedence="vite-rsc/client-reference"]';
  await expect.poll(() => countElements(page, `${stylesheet}[href*="Home.module.scss"]`)).toBe(1);
  await expect
    .poll(() => countElements(page, `${stylesheet}[href*="Transient.module.scss"]`))
    .toBe(1);
});

test('hard refresh and hydration keep the home stylesheet active every frame', async ({ page }) => {
  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await expectManagedOwner(page, 'Home.module.scss');

  await page.reload();
  await waitForRoute(page, 'home');
  await expectManagedOwner(page, 'Home.module.scss');
  await settleFrames(page);

  await assertTemporalInvariants(page);
  await assertManagedOwnerCardinality(page);
});

test('pure Server Component CSS remains active through initial document hydration', async ({
  page,
}) => {
  await page.goto(url('/server-only'));
  await waitForRoute(page, 'server');
  await settleFrames(page);

  await page.reload();
  await waitForRoute(page, 'server');
  await settleFrames(page);

  await assertTemporalInvariants(page);
  await expectActiveOwnerCount(page, 'ServerOnly.module.scss', 1);
  await assertManagedOwnerCardinality(page);
});

test('home to article navigation never exposes an unstyled committed tree', async ({ page }) => {
  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await waitForNavigationReady(page);
  await resetTemporalHistory(page);

  await page.locator('[data-nav="article"]').click();
  await waitForRoute(page, 'article');
  await expectManagedOwner(page, 'Article.module.scss');
  await settleFrames(page);

  await assertTemporalInvariants(page);
  await assertActiveRulesExclude(page, '--home-only-rule');
  await expectActiveOwnerCount(page, 'Home.module.scss', 0);
  await assertManagedOwnerCardinality(page);
});

test('twenty rapid alternating navigations preserve the latest committed route', async ({
  page,
}) => {
  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await waitForNavigationReady(page);
  await resetTemporalHistory(page);

  await page.evaluate(async () => {
    for (let index = 0; index < 20; index += 1) {
      history.pushState(null, '', index % 2 === 0 ? '/article' : '/');
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  });

  await waitForRoute(page, 'home');
  await expectManagedOwner(page, 'Home.module.scss');
  // Continue sampling after the latest route is ready so a late commit can still fail the test.
  await delay(500);

  await assertTemporalInvariants(page);
  await assertActiveRulesExclude(page, '--article-only-rule');
  await expectActiveOwnerCount(page, 'Article.module.scss', 0);
  await assertManagedOwnerCardinality(page);
});

test('CSS HMR replaces bytes without an unstyled frame or zero-owner mutation', async ({
  page,
}) => {
  const original = await readFile(homeStylePath, 'utf8');
  const updatedColor = 'rgb(11, 121, 71)';

  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await waitForNavigationReady(page);
  await resetTemporalHistory(page);

  try {
    await writeFile(homeStylePath, original.replace('rgb(1, 101, 51)', updatedColor));
    await expect.poll(() => readStyle(page, homeSentinel, 'color')).toBe(updatedColor);
    await settleFrames(page);

    await assertTemporalInvariants(page, {
      home: [...expectedColors.home, updatedColor],
      article: expectedColors.article,
      server: expectedColors.server,
    });
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeStylePath, original);
    await expect.poll(() => readStyle(page, homeSentinel, 'color')).toBe(expectedColors.home[0]);
  }
});

test('component prune and reimport commit the replacement stylesheet atomically', async ({
  page,
}) => {
  const original = await readFile(homeViewPath, 'utf8');
  const alternate = original.replaceAll('TransientPanel', 'TransientPanelAlt');

  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await waitForNavigationReady(page);
  await resetTemporalHistory(page);

  try {
    await writeFile(homeViewPath, alternate);
    const panel = '[data-transient-panel="alternate"]';
    await page.waitForSelector(panel, { visible: true });
    await expect.poll(() => readStyle(page, panel, '--transient-style-ready')).toBe('alternate');
    await settleFrames(page);

    await assertTemporalInvariants(page);
    await assertActiveRulesExclude(page, '--transient-style-ready: primary');
    await expectActiveOwnerCount(page, 'Transient.module.scss', 0);
    await expectManagedOwner(page, 'TransientAlt.module.scss');
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeViewPath, original);
    const panel = '[data-transient-panel="primary"]';
    await page.waitForSelector(panel, { visible: true });
    await expect.poll(() => readStyle(page, panel, '--transient-style-ready')).toBe('primary');
  }
});

test('removing and restoring an imported stylesheet releases only the removed owner', async ({
  page,
}) => {
  const original = await readFile(homeViewPath, 'utf8');
  const withoutRemoval = original
    .replace("import removalStyles from '../styles/Removal.module.scss';\n", '')
    .replace(' className={removalStyles.removable}', '');

  await page.goto(url('/'));
  await waitForRoute(page, 'home');
  await waitForNavigationReady(page);
  await resetTemporalHistory(page);

  try {
    await writeFile(homeViewPath, withoutRemoval);
    const removable = '[data-removable-style="present"]';
    await page.waitForSelector(removable, { visible: true });
    await expect.poll(() => readStyle(page, removable, '--removal-style-ready')).toBe('');
    await expectActiveOwnerCount(page, 'Removal.module.scss', 0);
    await settleFrames(page);

    await assertTemporalInvariants(page);
    await assertActiveRulesExclude(page, '--removal-style-ready');
    await expectManagedOwner(page, 'Home.module.scss');
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeViewPath, original);
    const removable = '[data-removable-style="present"]';
    await page.waitForSelector(removable, { visible: true });
    await expect.poll(() => readStyle(page, removable, '--removal-style-ready')).toBe('present');
  }
});

for (const mode of ['hydrated', 'CSR shell'] as const) {
  test(`a superseded ${mode} navigation aborts its browser RSC fetch without publishing route styles`, async ({
    page,
    diagnostics,
  }) => {
    if (mode === 'CSR shell') {
      await page.evaluateOnNewDocument(() => {
        Reflect.set(globalThis, '__SPA_MODE__', true);
      });
    }
    diagnostics.allowedFailurePatterns.push(
      /Article\.module\.scss.*__isr_engine_style_generation=/
    );

    const bootstrap = deferred();
    const responseReady = deferred();
    const prefetchReady = deferred();
    const releasePrefetch = deferred();
    const releaseResponse = deferred();
    const responseSettled = deferred();
    const prefetchFinished = deferred<HTTPRequest>();
    const aborted = deferred<HTTPRequest>();
    let routeError: unknown;
    const delayedRoute = /\/article_\.rsc\?abort=1$/;
    const onRequestFinished = (request: HTTPRequest) => {
      if (delayedRoute.test(request.url()) && !request.headers()[generationHeader]) {
        prefetchFinished.resolve(request);
      }
    };
    const onRequestFailed = (request: HTTPRequest) => {
      if (delayedRoute.test(request.url()) && request.headers()[generationHeader]) {
        aborted.resolve(request);
      }
    };
    const stopIntercepting = await interceptRequests(page, async request => {
      if (/\/.*virtual:isr-engine\/client-entry(?:\?|$)/.test(request.url())) {
        await bootstrap.promise;
        await request.continue();
        return;
      }
      if (!delayedRoute.test(request.url())) return;

      const isNavigation = !!request.headers()[generationHeader];
      try {
        // Keep the real RSC response ready while the browser request is still pending.
        const response = await fetch(request.url(), { headers: request.headers() });
        expect(response.ok).toBe(true);
        const body = Buffer.from(await response.arrayBuffer());
        const headers = new Headers(response.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) {
          headers.delete(name);
        }
        (isNavigation ? responseReady : prefetchReady).resolve();
        await (isNavigation ? releaseResponse : releasePrefetch).promise;
        await request.respond({
          status: response.status,
          headers: Object.fromEntries(headers),
          body,
        });
      } catch (error) {
        routeError = error;
        responseReady.resolve();
        prefetchReady.resolve();
      } finally {
        if (isNavigation) responseSettled.resolve();
      }
    });

    try {
      const navigation = page.goto(url('/'), { waitUntil: 'domcontentloaded' });
      void navigation.catch(() => undefined);
      try {
        // SSR styles can be ready while the navigation listener's hydration effect is absent.
        await waitForRoute(page, 'home');
        await page.waitForSelector('[data-hydration-ready]:disabled');
      } finally {
        bootstrap.resolve();
        await navigation;
      }
      await waitForNavigationReady(page);
      await resetTemporalHistory(page);

      page.on('requestfinished', onRequestFinished);
      page.on('requestfailed', onRequestFailed);
      await page.evaluate(() => {
        Reflect.set(globalThis, '__navigationDocument', true);
        const link = document.createElement('a');
        link.href = '/article?abort=1';
        link.dataset.prefetch = 'intent';
        document.body.append(link);
        link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      });
      await prefetchReady.promise;
      expect(routeError).toBeUndefined();
      await page.evaluate(() => history.pushState(null, '', '/article?abort=1'));
      await responseReady.promise;
      expect(routeError).toBeUndefined();
      const initialHomeToken = await page.$eval('body', node => node.dataset.renderToken);
      await page.evaluate(() => history.pushState(null, '', '/'));
      await expect
        .poll(() => page.$eval('body', node => node.dataset.renderToken))
        .not.toBe(initialHomeToken);
      // Only the browser navigation lifecycle can cancel this request.
      expect((await aborted.promise).failure()?.errorText).toBe('net::ERR_ABORTED');
      releasePrefetch.resolve();
      expect((await prefetchFinished.promise).failure()).toBeNull();
      releaseResponse.resolve();
      await responseSettled.promise;
      expect(routeError).toBeUndefined();
      await waitForRoute(page, 'home');
      expect(page.url()).toBe(url('/'));
      expect(await page.evaluate(() => Reflect.get(globalThis, '__navigationDocument'))).toBe(true);
      await settleFrames(page);

      await assertTemporalInvariants(page);
      await assertActiveRulesExclude(page, '--article-only-rule');
      await expectActiveOwnerCount(page, 'Article.module.scss', 0);
      await expectManagedOwner(page, 'Home.module.scss');
      await assertManagedOwnerCardinality(page);
    } finally {
      releasePrefetch.resolve();
      releaseResponse.resolve();
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      await stopIntercepting();
    }
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForNavigationReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-hydration-ready]:enabled');
}

function createDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    allowedFailurePatterns: [],
  };
  const documents = new DocumentRequestTracker();
  page.on('request', request => {
    documents.observe(
      request,
      request.isNavigationRequest() &&
        request.resourceType() === 'document' &&
        request.frame() === page.mainFrame()
    );
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) documents.commitMainDocument();
  });
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => {
    diagnostics.pageErrors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    );
  });
  page.on('requestfailed', request => {
    documents.navigationFailed(request);
    diagnostics.requestFailures.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      earlierDocument: documents.belongsToEarlierDocument(request),
      error: request.failure()?.errorText ?? 'unknown request failure',
      navigationRequest:
        request.method() === 'GET' &&
        request.resourceType() === 'fetch' &&
        new URL(request.url()).pathname.endsWith('_.rsc') &&
        /^\d+$/.test(request.headers()[generationHeader] ?? ''),
    });
  });
  return diagnostics;
}

function assertCleanDiagnostics(diagnostics: Diagnostics): void {
  const unexpectedFailures = diagnostics.requestFailures.filter(failure => {
    // Starting a newer document navigation can cancel earlier RSC prefetches.
    // Current-document speculation and all stylesheet failures remain visible.
    if (isExpectedRscCancellation(failure)) return false;
    return (
      !diagnostics.allowedFailurePatterns.some(pattern => pattern.test(failure.url)) ||
      !/abort|cancel/i.test(failure.error)
    );
  });
  expect(diagnostics.consoleErrors, 'browser console errors').toEqual([]);
  expect(diagnostics.pageErrors, 'uncaught browser page errors').toEqual([]);
  expect(unexpectedFailures, 'unexpected browser network failures').toEqual([]);
}

async function installTemporalObserver(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    type BrowserRoute = 'home' | 'article' | 'server';
    type BrowserOwner = { id: string; kind: string };
    type BrowserWindow = Window & {
      __styleFrames?: Array<{
        route: BrowserRoute;
        ready: string;
        color: string;
        ownerCount: number;
        at: number;
      }>;
      __styleOwnerEvents?: Array<{
        route: BrowserRoute;
        ownerCount: number;
        owners: BrowserOwner[];
        at: number;
      }>;
    };
    const browserWindow = window as BrowserWindow;
    browserWindow.__styleFrames = [];
    browserWindow.__styleOwnerEvents = [];

    const canonicalId = (value: string): string => {
      const url = new URL(value, document.baseURI);
      for (const key of ['direct', 't', 'v', 'import', '__isr_engine_style_generation']) {
        url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return `${url.pathname}${url.search}`;
    };
    const activeOwners = (): BrowserOwner[] => {
      const owners: BrowserOwner[] = [];
      document
        .querySelectorAll<HTMLElement>(
          'style[data-isr-engine-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
        )
        .forEach(node => {
          if (node instanceof HTMLLinkElement && node.media === 'not all') return;
          const raw =
            node instanceof HTMLLinkElement
              ? (node.getAttribute('href') ?? node.href)
              : (node.dataset.isrEngineDevStyle ?? node.dataset.viteDevId ?? '');
          if (!raw) return;
          owners.push({
            id: canonicalId(raw),
            kind:
              node instanceof HTMLLinkElement
                ? 'link'
                : node.dataset.isrEngineDevStyle
                  ? 'managed'
                  : 'vite',
          });
        });
      return owners;
    };
    const currentRoute = (): BrowserRoute | undefined => {
      const node = document.querySelector<HTMLElement>('[data-style-sentinel]');
      const route = node?.dataset.styleSentinel;
      return route === 'home' || route === 'article' || route === 'server' ? route : undefined;
    };
    const routeOwnerCount = (route: BrowserRoute, owners: BrowserOwner[]): number => {
      const files: Record<BrowserRoute, string> = {
        home: 'Home.module.scss',
        article: 'Article.module.scss',
        server: 'ServerOnly.module.scss',
      };
      const file = files[route];
      return owners.filter(owner => owner.id.endsWith(`/src/styles/${file}`)).length;
    };
    const recordOwnerEvent = () => {
      const route = currentRoute();
      if (!route) return;
      const owners = activeOwners();
      browserWindow.__styleOwnerEvents!.push({
        route,
        ownerCount: routeOwnerCount(route, owners),
        owners,
        at: performance.now(),
      });
    };
    new MutationObserver(recordOwnerEvent).observe(document, {
      attributes: true,
      attributeFilter: [
        'class',
        'data-style-sentinel',
        'href',
        'media',
        'rel',
        'data-isr-engine-dev-style',
        'data-vite-dev-id',
      ],
      childList: true,
      subtree: true,
    });
    const sample = () => {
      const node = document.querySelector<HTMLElement>('[data-style-sentinel]');
      const route = currentRoute();
      if (node && route) {
        const computed = getComputedStyle(node);
        const owners = activeOwners();
        browserWindow.__styleFrames!.push({
          route,
          ready: computed.getPropertyValue('--route-style-ready').trim(),
          color: computed.color,
          ownerCount: routeOwnerCount(route, owners),
          at: performance.now(),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function waitForRoute(page: Page, route: RouteName): Promise<void> {
  const sentinel = `[data-style-sentinel="${route}"]`;
  await page.waitForSelector(sentinel, { visible: true });
  await expect.poll(() => readStyle(page, sentinel, '--route-style-ready')).toBe(route);
  await expect.poll(() => readStyle(page, sentinel, 'color')).toBe(expectedColors[route][0]);
}

function readStyle(page: Page, selector: string, property: string): Promise<string> {
  return page.$eval(
    selector,
    (node, name) => getComputedStyle(node).getPropertyValue(name).trim(),
    property
  );
}

function countElements(page: Page, selector: string): Promise<number> {
  return page.$$eval(selector, nodes => nodes.length);
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
  );
}

async function resetTemporalHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as Window & {
      __styleFrames?: StyleFrame[];
      __styleOwnerEvents?: OwnerEvent[];
    };
    browserWindow.__styleFrames = [];
    browserWindow.__styleOwnerEvents = [];
  });
  await settleFrames(page);
}

async function assertTemporalInvariants(
  page: Page,
  colors: Record<RouteName, string[]> = expectedColors
): Promise<void> {
  const history = await page.evaluate(() => {
    const browserWindow = window as Window & {
      __styleFrames?: StyleFrame[];
      __styleOwnerEvents?: OwnerEvent[];
    };
    return {
      frames: browserWindow.__styleFrames ?? [],
      ownerEvents: browserWindow.__styleOwnerEvents ?? [],
    };
  });
  expect(
    history.frames.length,
    'the requestAnimationFrame sampler collected no frames'
  ).toBeGreaterThan(0);
  expect(
    history.frames.filter(frame => frame.ready !== frame.route),
    'a committed sentinel was observed without its route CSS custom property'
  ).toEqual([]);
  expect(
    history.frames.filter(frame => !colors[frame.route].includes(frame.color)),
    'a committed sentinel was observed with the wrong computed color'
  ).toEqual([]);
  expect(
    history.frames.filter(frame => frame.ownerCount === 0),
    'a sampled committed route had no active stylesheet owner'
  ).toEqual([]);
  expect(
    history.ownerEvents.filter(event => event.ownerCount === 0),
    'a DOM mutation exposed a committed route with no active stylesheet owner'
  ).toEqual([]);
}

async function expectManagedOwner(page: Page, fileName: string): Promise<void> {
  await expect
    .poll(() => countElements(page, `style[data-isr-engine-dev-style$="/src/styles/${fileName}"]`))
    .toBe(1);
}

async function expectActiveOwnerCount(page: Page, fileName: string, count: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(file => {
        const canonicalId = (value: string): string => {
          const url = new URL(value, document.baseURI);
          for (const key of ['direct', 't', 'v', 'import', '__isr_engine_style_generation']) {
            url.searchParams.delete(key);
          }
          url.searchParams.sort();
          return `${url.pathname}${url.search}`;
        };
        return Array.from(
          document.querySelectorAll<HTMLElement>(
            'style[data-isr-engine-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
          )
        ).filter(node => {
          if (node instanceof HTMLLinkElement && node.media === 'not all') return false;
          const raw =
            node instanceof HTMLLinkElement
              ? (node.getAttribute('href') ?? node.href)
              : (node.dataset.isrEngineDevStyle ?? node.dataset.viteDevId ?? '');
          return raw !== '' && canonicalId(raw).endsWith(`/src/styles/${file}`);
        }).length;
      }, fileName)
    )
    .toBe(count);
}

async function assertManagedOwnerCardinality(page: Page): Promise<void> {
  const duplicateOwners = await page.evaluate(() => {
    const counts = new Map<string, number>();
    document
      .querySelectorAll<HTMLStyleElement>('style[data-isr-engine-dev-style]')
      .forEach(node => {
        const id = node.dataset.isrEngineDevStyle ?? '';
        counts.set(id, (counts.get(id) ?? 0) + 1);
      });
    return Array.from(counts).filter(([, count]) => count > 1);
  });
  expect(duplicateOwners, 'more than one engine-managed node owns a canonical id').toEqual([]);
}

async function assertActiveRulesExclude(page: Page, marker: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(ruleMarker => {
        const text: string[] = [];
        document
          .querySelectorAll<HTMLElement>(
            'style[data-isr-engine-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
          )
          .forEach(node => {
            if (node instanceof HTMLLinkElement && node.media === 'not all') return;
            if (node instanceof HTMLStyleElement) {
              text.push(node.textContent ?? '');
              return;
            }
            try {
              text.push(
                Array.from(
                  (node as HTMLLinkElement).sheet?.cssRules ?? [],
                  rule => rule.cssText
                ).join('\n')
              );
            } catch (error) {
              text.push(`stylesheet-inspection-error:${String(error)}`);
            }
          });
        return text.some(cssText => cssText.includes(ruleMarker));
      }, marker)
    )
    .toBe(false);
}
