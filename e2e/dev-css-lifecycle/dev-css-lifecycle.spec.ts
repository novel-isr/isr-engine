import { expect, test, type ConsoleMessage, type Page, type Request } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  requestFailures: Array<{ url: string; error: string }>;
  allowedFailurePatterns: RegExp[];
}

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const homeStylePath = path.join(fixtureRoot, 'src/styles/Home.module.scss');
const homeViewPath = path.join(fixtureRoot, 'src/components/HomeView.client.tsx');
const expectedColors: Record<RouteName, string[]> = {
  home: ['rgb(1, 101, 51)'],
  article: ['rgb(91, 41, 171)'],
  server: ['rgb(161, 71, 21)'],
};

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  Reflect.set(page, '__devCssDiagnostics', diagnostics);
  await installTemporalObserver(page);
});

test.afterEach(async ({ page }) => {
  assertCleanDiagnostics(Reflect.get(page, '__devCssDiagnostics') as Diagnostics);
});

test('cold SSR applies direct and transitive client CSS before the client entry starts', async ({
  page,
}) => {
  await page.route(/virtual:vite-rsc\/entry-browser/, route =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: 'export {};',
    })
  );

  await page.goto('/');

  const home = page.locator('[data-style-sentinel="home"]');
  const nested = page.locator('[data-transient-panel="primary"]');
  await expect(home).toBeVisible();
  await expect
    .poll(() =>
      home.evaluate(node => getComputedStyle(node).getPropertyValue('--route-style-ready').trim())
    )
    .toBe('home');
  await expect
    .poll(() =>
      nested.evaluate(node =>
        getComputedStyle(node).getPropertyValue('--transient-style-ready').trim()
      )
    )
    .toBe('primary');

  await expect(page.locator('style[data-novel-isr-dev-style]')).toHaveCount(0);
  await expect(
    page.locator(
      'link[rel="stylesheet"][data-precedence="vite-rsc/client-reference"][href*="Home.module.scss"]'
    )
  ).toHaveCount(1);
  await expect(
    page.locator(
      'link[rel="stylesheet"][data-precedence="vite-rsc/client-reference"][href*="Transient.module.scss"]'
    )
  ).toHaveCount(1);
});

test('hard refresh and hydration keep the home stylesheet active every frame', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/server-only');
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
  await page.goto('/');
  await waitForRoute(page, 'home');
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
  await page.goto('/');
  await waitForRoute(page, 'home');
  await resetTemporalHistory(page);

  await page.evaluate(async () => {
    for (let index = 0; index < 20; index += 1) {
      history.pushState(null, '', index % 2 === 0 ? '/article' : '/');
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  });

  await waitForRoute(page, 'home');
  await expectManagedOwner(page, 'Home.module.scss');
  await page.waitForTimeout(500);

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

  await page.goto('/');
  await waitForRoute(page, 'home');
  await resetTemporalHistory(page);

  try {
    await writeFile(homeStylePath, original.replace('rgb(1, 101, 51)', updatedColor));
    await expect(page.locator('[data-style-sentinel="home"]')).toHaveCSS('color', updatedColor);
    await settleFrames(page);

    await assertTemporalInvariants(page, {
      home: [...expectedColors.home, updatedColor],
      article: expectedColors.article,
      server: expectedColors.server,
    });
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeStylePath, original);
    await expect(page.locator('[data-style-sentinel="home"]')).toHaveCSS(
      'color',
      expectedColors.home[0]!
    );
  }
});

test('component prune and reimport commit the replacement stylesheet atomically', async ({
  page,
}) => {
  const original = await readFile(homeViewPath, 'utf8');
  const alternate = original.replaceAll('TransientPanel', 'TransientPanelAlt');

  await page.goto('/');
  await waitForRoute(page, 'home');
  await resetTemporalHistory(page);

  try {
    await writeFile(homeViewPath, alternate);
    const panel = page.locator('[data-transient-panel="alternate"]');
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        panel.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--transient-style-ready').trim()
        )
      )
      .toBe('alternate');
    await settleFrames(page);

    await assertTemporalInvariants(page);
    await assertActiveRulesExclude(page, '--transient-style-ready: primary');
    await expectActiveOwnerCount(page, 'Transient.module.scss', 0);
    await expectManagedOwner(page, 'TransientAlt.module.scss');
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeViewPath, original);
    const panel = page.locator('[data-transient-panel="primary"]');
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        panel.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--transient-style-ready').trim()
        )
      )
      .toBe('primary');
  }
});

test('removing and restoring an imported stylesheet releases only the removed owner', async ({
  page,
}) => {
  const original = await readFile(homeViewPath, 'utf8');
  const withoutRemoval = original
    .replace("import removalStyles from '../styles/Removal.module.scss';\n", '')
    .replace(' className={removalStyles.removable}', '');

  await page.goto('/');
  await waitForRoute(page, 'home');
  await resetTemporalHistory(page);

  try {
    await writeFile(homeViewPath, withoutRemoval);
    const removable = page.locator('[data-removable-style="present"]');
    await expect(removable).toBeVisible();
    await expect
      .poll(() =>
        removable.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--removal-style-ready').trim()
        )
      )
      .toBe('');
    await expectActiveOwnerCount(page, 'Removal.module.scss', 0);
    await settleFrames(page);

    await assertTemporalInvariants(page);
    await assertActiveRulesExclude(page, '--removal-style-ready');
    await expectManagedOwner(page, 'Home.module.scss');
    await assertManagedOwnerCardinality(page);
  } finally {
    await writeFile(homeViewPath, original);
    const removable = page.locator('[data-removable-style="present"]');
    await expect(removable).toBeVisible();
    await expect
      .poll(() =>
        removable.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--removal-style-ready').trim()
        )
      )
      .toBe('present');
  }
});

test('an aborted RSC fetch cannot publish or commit its route stylesheet', async ({ page }) => {
  const diagnostics = Reflect.get(page, '__devCssDiagnostics') as Diagnostics;
  diagnostics.allowedFailurePatterns.push(
    /\/article_\.rsc\?delay=750/,
    /Article\.module\.scss.*__novel_isr_style_generation=/
  );

  await page.goto('/');
  await waitForRoute(page, 'home');
  await resetTemporalHistory(page);

  const articleRequest = page.waitForRequest(request =>
    request.url().includes('/article_.rsc?delay=750')
  );
  await page.evaluate(() => history.pushState(null, '', '/article?delay=750'));
  await articleRequest;
  await page.waitForTimeout(50);
  await page.evaluate(() => history.pushState(null, '', '/'));

  await waitForRoute(page, 'home');
  await page.waitForTimeout(900);
  await expect(page).toHaveURL('/');

  await assertTemporalInvariants(page);
  await assertActiveRulesExclude(page, '--article-only-rule');
  await expectActiveOwnerCount(page, 'Article.module.scss', 0);
  await expectManagedOwner(page, 'Home.module.scss');
  await assertManagedOwnerCardinality(page);
});

function createDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    allowedFailurePatterns: [],
  };
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => diagnostics.pageErrors.push(error.stack ?? error.message));
  page.on('requestfailed', (request: Request) => {
    diagnostics.requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'unknown request failure',
    });
  });
  return diagnostics;
}

function assertCleanDiagnostics(diagnostics: Diagnostics): void {
  const unexpectedFailures = diagnostics.requestFailures.filter(
    failure =>
      !diagnostics.allowedFailurePatterns.some(pattern => pattern.test(failure.url)) ||
      !/abort|cancel/i.test(failure.error)
  );
  expect(diagnostics.consoleErrors, 'browser console errors').toEqual([]);
  expect(diagnostics.pageErrors, 'uncaught browser page errors').toEqual([]);
  expect(unexpectedFailures, 'unexpected browser network failures').toEqual([]);
}

async function installTemporalObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
      for (const key of ['direct', 't', 'v', 'import', '__novel_isr_style_generation']) {
        url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return `${url.pathname}${url.search}`;
    };
    const activeOwners = (): BrowserOwner[] => {
      const owners: BrowserOwner[] = [];
      document
        .querySelectorAll<HTMLElement>(
          'style[data-novel-isr-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
        )
        .forEach(node => {
          if (node instanceof HTMLLinkElement && node.media === 'not all') return;
          const raw =
            node instanceof HTMLLinkElement
              ? (node.getAttribute('href') ?? node.href)
              : (node.dataset.novelIsrDevStyle ?? node.dataset.viteDevId ?? '');
          if (!raw) return;
          owners.push({
            id: canonicalId(raw),
            kind:
              node instanceof HTMLLinkElement
                ? 'link'
                : node.dataset.novelIsrDevStyle
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
        'data-novel-isr-dev-style',
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
  const sentinel = page.locator(`[data-style-sentinel="${route}"]`);
  await expect(sentinel).toBeVisible();
  await expect
    .poll(() =>
      sentinel.evaluate(node =>
        getComputedStyle(node).getPropertyValue('--route-style-ready').trim()
      )
    )
    .toBe(route);
  await expect(sentinel).toHaveCSS('color', expectedColors[route][0]!);
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
    .poll(() => page.locator(`style[data-novel-isr-dev-style$="/src/styles/${fileName}"]`).count())
    .toBe(1);
}

async function expectActiveOwnerCount(page: Page, fileName: string, count: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(file => {
        const canonicalId = (value: string): string => {
          const url = new URL(value, document.baseURI);
          for (const key of ['direct', 't', 'v', 'import', '__novel_isr_style_generation']) {
            url.searchParams.delete(key);
          }
          url.searchParams.sort();
          return `${url.pathname}${url.search}`;
        };
        return Array.from(
          document.querySelectorAll<HTMLElement>(
            'style[data-novel-isr-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
          )
        ).filter(node => {
          if (node instanceof HTMLLinkElement && node.media === 'not all') return false;
          const raw =
            node instanceof HTMLLinkElement
              ? (node.getAttribute('href') ?? node.href)
              : (node.dataset.novelIsrDevStyle ?? node.dataset.viteDevId ?? '');
          return raw !== '' && canonicalId(raw).endsWith(`/src/styles/${file}`);
        }).length;
      }, fileName)
    )
    .toBe(count);
}

async function assertManagedOwnerCardinality(page: Page): Promise<void> {
  const duplicateOwners = await page.evaluate(() => {
    const counts = new Map<string, number>();
    document.querySelectorAll<HTMLStyleElement>('style[data-novel-isr-dev-style]').forEach(node => {
      const id = node.dataset.novelIsrDevStyle ?? '';
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
            'style[data-novel-isr-dev-style],style[data-vite-dev-id],link[rel="stylesheet"][data-precedence^="vite-rsc/"]'
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
