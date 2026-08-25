# Dev CSS Single-Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the development-only one-shot CSS handoff with an engine-owned registry that never exposes a committed React tree without an active stylesheet.

**Architecture:** SSR stylesheet links bootstrap the page. Vite continues compiling CSS and CSS Modules, but a post-transform redirects its DOM side effects into one engine runtime registry; that registry atomically replaces bootstrap links, updates one persistent style node per canonical id, and defers prune removal until the enclosing HMR/RSC transaction commits.

**Tech Stack:** TypeScript, Vite 8 plugin hooks, React 19 RSC, Vitest, happy-dom, Playwright Chromium, pnpm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-25-dev-css-single-owner-design.md`

## Global Constraints

- All lifecycle behavior lives in `@novel-isr/engine`; applications add no provider, hook, runtime import, copied code, or Vite configuration.
- Production CSS generation and runtime behavior remain unchanged.
- The active committed tree always has an SSR link or engine-managed style for every required stylesheet.
- CSS replacement installs the new owner before releasing the old owner.
- Unknown Vite CSS wrapper shapes fail loudly in development.
- Keep `?direct` for SSR stylesheet transport identity.
- Test hard refresh, hydration, RSC navigation, rapid navigation, CSS HMR, component prune/reimport, stylesheet removal, and aborted navigation.

## File Structure

- Create `src/defaults/runtime/dev-style-id.ts`: canonical style-id parsing and matching without DOM or Vite dependencies.
- Create `src/defaults/runtime/dev-style-registry.client.ts`: engine-owned DOM registry and transaction state machine.
- Create `src/plugin/transformDevCssModule.ts`: parsed transformation of Vite's development CSS wrapper.
- Modify `src/plugin/createDevCssHandoffPlugin.ts`: expose pre and post lifecycle plugins and virtual registry modules.
- Modify `src/plugin/createIsrPlugin.ts`: install the complete lifecycle plugin set.
- Replace `src/defaults/runtime/dev-css-handoff.client.ts`: remove one-shot ownership logic after consumers migrate.
- Replace/add focused Vitest files under the adjacent `__tests__` directories.
- Create `e2e/dev-css-lifecycle/`: real development fixture with disjoint route and HMR styles.
- Create `playwright.config.ts`: temporal browser regression configuration.
- Modify `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, and `.github/workflows/publish.yml`: browser test command and release gates.

---

### Task 1: Capture The Ownership Gap And Canonical Identity

**Files:**
- Create: `src/defaults/runtime/dev-style-id.ts`
- Create: `src/defaults/runtime/__tests__/dev-style-id.test.ts`
- Replace: `src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts`

**Interfaces:**
- Produces: `canonicalizeDevStyleId(value: string, baseUrl?: string): string`
- Produces: `styleIdsMatch(left: string, right: string, baseUrl?: string): boolean`
- Establishes the failing invariant consumed by Task 2: pruning the client node cannot leave the stylesheet owner set empty.

- [ ] **Step 1: Write canonical-id tests**

```ts
expect(canonicalizeDevStyleId('/src/Card.scss?direct&t=42')).toBe('/src/Card.scss');
expect(canonicalizeDevStyleId('http://localhost:3000/src/Card.scss?direct')).toBe('/src/Card.scss');
expect(canonicalizeDevStyleId('/src/Card.scss?theme=dark&direct')).toBe(
  '/src/Card.scss?theme=dark'
);
expect(styleIdsMatch('/workspace/app/src/Card.scss', '/src/Card.scss?direct')).toBe(true);
```

- [ ] **Step 2: Run the focused test and verify the new module is missing**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-id.test.ts`

Expected: FAIL because `dev-style-id.ts` does not exist.

- [ ] **Step 3: Implement canonicalization**

```ts
const TRANSPORT_QUERY_KEYS = new Set(['direct', 't', 'v', 'import']);

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function canonicalizeDevStyleId(value: string, baseUrl = 'http://novel-isr.local/'): string {
  const decoded = decodeURIComponentSafely(value).replaceAll('\\', '/');
  const url = new URL(decoded, baseUrl);
  for (const key of TRANSPORT_QUERY_KEYS) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

export function styleIdsMatch(left: string, right: string, baseUrl?: string): boolean {
  const a = canonicalizeDevStyleId(left, baseUrl);
  const b = canonicalizeDevStyleId(right, baseUrl);
  return a === b || a.endsWith(b) || b.endsWith(a);
}
```

- [ ] **Step 4: Add the regression test for the current empty-owner state**

The test creates one SSR link and one Vite style, runs the legacy handoff, removes the Vite style as `hot.prune` does, and asserts that either the link or a managed style must still exist. Against v2.6.2 the final assertion must fail.

```ts
const ownerCount = () =>
  document.querySelectorAll(
    'link[href*="Card.scss"],style[data-vite-dev-id*="Card.scss"],style[data-novel-isr-dev-style*="Card.scss"]'
  ).length;

expect(ownerCount()).toBeGreaterThan(0);
```

- [ ] **Step 5: Run both tests**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-id.test.ts src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts`

Expected: canonical-id tests PASS; ownership regression FAIL at `ownerCount()` and proves the current gap.

- [ ] **Step 6: Commit the reproduction and identity helper**

```bash
git add src/defaults/runtime/dev-style-id.ts src/defaults/runtime/__tests__/dev-style-id.test.ts src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts
git commit -m "test(dev): reproduce CSS ownership gap"
```

---

### Task 2: Implement The Engine-Owned Style Registry

**Files:**
- Create: `src/defaults/runtime/dev-style-registry.client.ts`
- Create: `src/defaults/runtime/__tests__/dev-style-registry.client.test.ts`
- Modify: `src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts`

**Interfaces:**
- Consumes: `canonicalizeDevStyleId` and `styleIdsMatch` from Task 1.
- Produces: `createDevStyleRegistry(document: Document): DevStyleRegistry`
- Produces: `DevStyleRegistry.publish(id: string, cssText: string): void`
- Produces: `DevStyleRegistry.prune(id: string): void`
- Produces: `DevStyleRegistry.beginUpdate(): void`, `commitUpdate(activeIds?: Iterable<string>): void`, and `abortUpdate(): void`
- Produces: `DevStyleRegistry.reconcileDocumentStyles(): void` and `dispose(): void`

- [ ] **Step 1: Write registry state-machine tests**

Cover these exact cases:

```ts
registry.publish('/src/Card.scss', '.card { color: green }');
expect(document.querySelector('style[data-novel-isr-dev-style="/src/Card.scss"]')).not.toBeNull();
expect(document.querySelector('link[href*="Card.scss"]')).toBeNull();

const node = document.querySelector('style')!;
registry.publish('/src/Card.scss', '.card { color: blue }');
expect(document.querySelector('style')).toBe(node);
expect(node.textContent).toContain('blue');

registry.beginUpdate();
registry.prune('/src/Card.scss');
expect(node.isConnected).toBe(true);
registry.publish('/src/Card.scss', '.card { color: red }');
registry.commitUpdate(['/src/Card.scss']);
expect(node.isConnected).toBe(true);
```

Also test prune-without-republish, abort, duplicate publish, importer-resource link adoption, and idempotent dispose.

- [ ] **Step 2: Run the registry test and verify it fails**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-registry.client.test.ts`

Expected: FAIL because `createDevStyleRegistry` does not exist.

- [ ] **Step 3: Implement the focused registry records**

```ts
interface StyleRecord {
  id: string;
  state: 'ssr-active' | 'client-active' | 'updating' | 'pending-release' | 'released';
  node?: HTMLStyleElement;
  cssText?: string;
  pendingRelease: boolean;
}

export interface DevStyleRegistry {
  publish(id: string, cssText: string): void;
  prune(id: string): void;
  beginUpdate(): void;
  commitUpdate(activeIds?: Iterable<string>): void;
  abortUpdate(): void;
  reconcileDocumentStyles(): void;
  dispose(): void;
}
```

`publish` must synchronously create/update the managed node before calling `remove()` on matching `link[data-precedence^="vite-rsc/"]` nodes. `prune` only marks pending release. `commitUpdate` removes a pending record only when it is not present in `activeIds`; `abortUpdate` clears pending releases without changing connected nodes.

- [ ] **Step 4: Run registry and original regression tests**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-registry.client.test.ts src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts`

Expected: PASS, including the invariant that the owner count never reaches zero.

- [ ] **Step 5: Commit the registry**

```bash
git add src/defaults/runtime/dev-style-registry.client.ts src/defaults/runtime/__tests__/dev-style-registry.client.test.ts src/defaults/runtime/__tests__/dev-css-handoff.client.test.ts
git commit -m "feat(dev): add transactional style registry"
```

---

### Task 3: Redirect Vite CSS Modules Into The Registry

**Files:**
- Create: `src/plugin/transformDevCssModule.ts`
- Create: `src/plugin/__tests__/transformDevCssModule.test.ts`
- Modify: `src/plugin/createDevCssHandoffPlugin.ts`
- Modify: `src/plugin/__tests__/createDevCssHandoffPlugin.test.ts`

**Interfaces:**
- Produces: `transformDevCssModule(code: string, id: string, registryId: string): TransformResult | undefined`
- Produces: `createDevCssLifecyclePlugins(defaultsDir: string): Plugin[]`
- Keeps: `canonicalizeDevRscStylesheetModule(code: string, id: string)` for direct SSR URLs.
- Virtual id: `virtual:novel-isr/dev-style-registry`
- Resolved id: `\0virtual:novel-isr/dev-style-registry`

- [ ] **Step 1: Write wrapper transformation tests**

Use the exact Vite 8 development wrapper shape:

```ts
const input = `
import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "/@vite/client";
const __vite__id = "/src/Card.module.scss";
const __vite__css = ".card{color:green}";
__vite__updateStyle(__vite__id, __vite__css);
import.meta.hot.prune(() => __vite__removeStyle(__vite__id));
export default { card: "_card_123" };
`;
```

Assert that transformed code imports the engine registry, calls `publish(__vite__id, __vite__css)`, calls `prune(__vite__id)` from the hot callback, preserves the default CSS Modules export, and no longer calls Vite DOM mutators. Test plain CSS, SCSS, CSS Modules, `?direct` exclusion, unrelated JS, malformed wrapper, and aliased import names.

- [ ] **Step 2: Run transform tests and verify failure**

Run: `pnpm vitest run src/plugin/__tests__/transformDevCssModule.test.ts`

Expected: FAIL because the transformer does not exist.

- [ ] **Step 3: Implement an AST-validated transform**

Parse with TypeScript, locate imported `updateStyle`/`removeStyle` bindings from `/@vite/client`, and require the top-level update call plus hot prune callback before changing code. Use source positions to make replacements and prepend:

```ts
import { devStyleRegistry as __novel_isr_dev_styles } from "virtual:novel-isr/dev-style-registry";
```

Replace only the two validated call expressions:

```ts
__novel_isr_dev_styles.publish(__vite__id, __vite__css);
import.meta.hot.prune(() => __novel_isr_dev_styles.prune(__vite__id));
```

If a stylesheet request contains a partial/unknown Vite wrapper, throw a development compatibility error naming `id`; non-stylesheet modules return `undefined`.

- [ ] **Step 4: Split the engine integration into pre and post plugins**

The pre plugin retains virtual cleanup interception and `?direct` RSC transformation. The post plugin runs `transformDevCssModule` after Vite's CSS compiler. Resolve/load the registry virtual id to a client-only module that creates one registry and binds its own `import.meta.hot` events:

```ts
export const devStyleRegistry = createDevStyleRegistry(document);
import.meta.hot?.on('vite:beforeUpdate', () => devStyleRegistry.beginUpdate());
import.meta.hot?.on('vite:afterUpdate', () => devStyleRegistry.commitUpdate());
import.meta.hot?.on('vite:error', () => devStyleRegistry.abortUpdate());
```

- [ ] **Step 5: Run plugin-focused tests**

Run: `pnpm vitest run src/plugin/__tests__/transformDevCssModule.test.ts src/plugin/__tests__/createDevCssHandoffPlugin.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the Vite ownership redirect**

```bash
git add src/plugin/transformDevCssModule.ts src/plugin/__tests__/transformDevCssModule.test.ts src/plugin/createDevCssHandoffPlugin.ts src/plugin/__tests__/createDevCssHandoffPlugin.test.ts
git commit -m "feat(dev): route Vite CSS through engine registry"
```

---

### Task 4: Bind RSC Stylesheet Commit And Cleanup To The Registry

**Files:**
- Modify: `src/defaults/runtime/dev-style-registry.client.ts`
- Replace: `src/defaults/runtime/dev-css-handoff.client.ts`
- Modify: `src/defaults/runtime/__tests__/dev-style-registry.client.test.ts`
- Modify: `src/plugin/createDevCssHandoffPlugin.ts`
- Modify: `src/plugin/__tests__/devStylesheetIdentity.integration.test.ts`
- Modify: `src/plugin/createIsrPlugin.ts`

**Interfaces:**
- Consumes: `DevStyleRegistry` and `createDevCssLifecyclePlugins` from Tasks 2-3.
- Produces: virtual React component `DevCssLifecycleBoundary` whose `useLayoutEffect` calls `reconcileDocumentStyles()` after an RSC commit.
- Replaces the upstream `virtual:vite-rsc/remove-duplicate-server-css` module without application participation.

- [ ] **Step 1: Write RSC reconciliation tests**

Test a current committed set `A`, a pending set `B`, successful commit, and abort:

```ts
registry.publish('/src/A.scss', '.a{display:block}');
registry.beginUpdate();
appendRscLink(document, '/src/B.scss?direct');
registry.reconcileDocumentStyles();
registry.publish('/src/B.scss', '.b{display:grid}');
registry.commitUpdate(['/src/B.scss']);
expect(style('/src/B.scss')).not.toBeNull();
expect(style('/src/A.scss')).toBeNull();
```

Assert ordering through a mutation log: the B style insertion occurs before the B link removal and before the A style removal. An aborted transaction keeps A and removes no committed owner.

- [ ] **Step 2: Run the RSC-focused tests and verify failure**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-registry.client.test.ts src/plugin/__tests__/devStylesheetIdentity.integration.test.ts`

Expected: FAIL because the virtual lifecycle component and active-set reconciliation are not wired.

- [ ] **Step 3: Replace the legacy handoff component**

The resolved upstream cleanup module must load this shape:

```ts
"use client";
import * as React from "react";
import { devStyleRegistry } from "virtual:novel-isr/dev-style-registry";

export default function DevCssLifecycleBoundary() {
  React.useLayoutEffect(() => devStyleRegistry.reconcileDocumentStyles());
  return null;
}
```

Delete `handoffDevClientReferenceStyles` and its `MutationObserver`. The registry may observe links only to record pending resources; it must never perform a one-shot remove based merely on another node appearing.

- [ ] **Step 4: Install both lifecycle plugins in engine order**

Change `createIsrPlugin.ts` from one plugin call to:

```ts
...createDevCssLifecyclePlugins(resolveEngineDefaultsDir()),
```

Keep the pre plugin before `@vitejs/plugin-rsc` and the post transform after Vite CSS processing by hook enforcement.

- [ ] **Step 5: Expand the real Vite integration test**

Assert that `/src/ClientCard.module.scss` returns JavaScript which:

- preserves `export default` class mappings;
- imports the engine virtual registry;
- calls registry `publish` and `prune`;
- contains no executable `__vite__updateStyle` or `__vite__removeStyle` calls;
- keeps `/src/ClientCard.module.scss?direct` as `text/css`.

- [ ] **Step 6: Run all lifecycle unit and integration tests**

Run: `pnpm vitest run src/defaults/runtime/__tests__/dev-style-*.test.ts src/defaults/runtime/__tests__/stylesheet-lifecycle-ownership.test.ts src/plugin/__tests__/createDevCssHandoffPlugin.test.ts src/plugin/__tests__/transformDevCssModule.test.ts src/plugin/__tests__/devStylesheetIdentity.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit RSC transaction integration**

```bash
git add src/defaults/runtime src/plugin/createDevCssHandoffPlugin.ts src/plugin/createIsrPlugin.ts src/plugin/__tests__
git commit -m "fix(dev): make RSC stylesheet commits atomic"
```

---

### Task 5: Add Real-Browser Temporal Regression Coverage

**Files:**
- Create: `e2e/dev-css-lifecycle/package.json`
- Create: `e2e/dev-css-lifecycle/vite.config.ts`
- Create: `e2e/dev-css-lifecycle/ssr.config.ts`
- Create: `e2e/dev-css-lifecycle/src/app.tsx`
- Create: `e2e/dev-css-lifecycle/src/routes.tsx`
- Create: `e2e/dev-css-lifecycle/src/styles/*.scss`
- Create: `e2e/dev-css-lifecycle/dev-css-lifecycle.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`

**Interfaces:**
- Adds command: `pnpm test:browser`
- Uses the engine's normal `createIsrPlugin()` and default entries; the fixture contains no lifecycle workaround.
- Exposes sentinel attributes `data-style-sentinel="home|article"` only for test observation.

- [ ] **Step 1: Add Playwright and the browser test command**

Run: `pnpm add -D @playwright/test`

Add:

```json
"test:browser": "playwright test e2e/dev-css-lifecycle/dev-css-lifecycle.spec.ts"
```

- [ ] **Step 2: Build the engine-only fixture**

Create two routes with disjoint computed values:

```scss
/* Home.module.scss */
.sentinel { --route-style-ready: home; color: rgb(1, 101, 51); }

/* Article.module.scss */
.sentinel { --route-style-ready: article; color: rgb(91, 41, 171); }
```

The fixture imports styles normally and starts through `novel-isr dev`; it must not import the registry or configure the lifecycle plugins directly.

- [ ] **Step 3: Write a frame sampler before interactions**

```ts
await page.addInitScript(() => {
  (window as any).__styleFrames = [];
  const sample = () => {
    const node = document.querySelector<HTMLElement>('[data-style-sentinel]');
    if (node) {
      (window as any).__styleFrames.push({
        route: node.dataset.styleSentinel,
        ready: getComputedStyle(node).getPropertyValue('--route-style-ready').trim(),
        color: getComputedStyle(node).color,
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
```

For every sampled frame, assert `ready === route`. Also collect style/link ownership counts with a `MutationObserver` and assert they never reach zero for the committed route.

- [ ] **Step 4: Add all temporal scenarios**

Create separate tests for hard refresh/hydration, home-to-article navigation, 20 rapid alternating navigations, editing CSS to trigger CSS HMR, editing the component to force prune/reimport, removing an imported stylesheet, and a deliberately aborted RSC fetch. Each test restores modified fixture files in `finally`.

- [ ] **Step 5: Commit the browser tests without changing runtime behavior**

```bash
git add e2e/dev-css-lifecycle playwright.config.ts package.json pnpm-lock.yaml .gitignore
git commit -m "test(dev): cover CSS lifecycle in a real browser"
```

- [ ] **Step 6: Prove the browser test detects v2.6.2 in an isolated worktree**

Apply the browser-test-only commit to the old implementation without changing either working tree's runtime source:

```bash
BROWSER_TEST_COMMIT=$(git rev-parse HEAD)
LEGACY_WORKTREE=$(mktemp -d /tmp/isr-engine-v262.XXXXXX)
git worktree add -b verify-v262-css "$LEGACY_WORKTREE" v2.6.2
git -C "$LEGACY_WORKTREE" cherry-pick "$BROWSER_TEST_COMMIT"
pnpm --dir "$LEGACY_WORKTREE" install
pnpm --dir "$LEGACY_WORKTREE" exec playwright install chromium
pnpm --dir "$LEGACY_WORKTREE" test:browser
```

Expected: the final command FAILS with at least one frame where `ready` is empty or an ownership count is zero. Save the failing trace, then clean up:

```bash
git worktree remove --force "$LEGACY_WORKTREE"
git branch -D verify-v262-css
```

- [ ] **Step 7: Run against the new registry**

Run: `pnpm test:browser`

Expected: all scenarios PASS; obsolete route rules are absent after committed navigation; exactly one engine client style node exists per canonical id after bootstrap.

---

### Task 6: Add CI Gates And Complete Engine Verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish.yml`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- CI installs Chromium with `pnpm exec playwright install --with-deps chromium` and runs `pnpm test:browser`.
- Publish runs `pnpm run check`, `pnpm run test:browser`, and `pnpm run build` before `npm publish`.
- Releases the next unused patch version after checking remote tags and package registry.

- [ ] **Step 1: Add the browser CI job**

Add a dedicated job with a 15-minute timeout, dependency install, Chromium install, and `pnpm test:browser`. Upload `playwright-report/` and `test-results/` when it fails.

- [ ] **Step 2: Strengthen the publish workflow**

Before `npm publish`, run:

```yaml
- name: Check
  run: pnpm run check
- name: Install Chromium
  run: pnpm exec playwright install --with-deps chromium
- name: Browser regression tests
  run: pnpm run test:browser
```

- [ ] **Step 3: Run focused and full local verification**

Run:

```bash
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run test:browser
pnpm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Update version and changelog only after tests pass**

Query existing tags and published package versions, choose the next unused patch version, update `package.json` and lockfile, and document the single-owner registry, removed one-shot handoff, compatibility validation, and browser regression gate.

- [ ] **Step 5: Re-run release-equivalent verification**

Run: `pnpm run check && pnpm run test:browser && pnpm run build`

Expected: exit 0.

- [ ] **Step 6: Commit the release candidate**

```bash
git add .github/workflows/ci.yml .github/workflows/publish.yml CHANGELOG.md package.json pnpm-lock.yaml
git commit -m "chore: release engine CSS lifecycle fix"
```

---

### Task 7: Publish Through CI/CD And Verify The Business Consumer

**Files:**
- Engine: no source edits after the verified release commit except an annotated version tag.
- Modify in consumer: `/Users/fengwenxuan/Desktop/startup-project/blog/moxixii-blog/package.json`
- Modify in consumer: `/Users/fengwenxuan/Desktop/startup-project/blog/moxixii-blog/pnpm-lock.yaml`
- Restore in consumer: `/Users/fengwenxuan/Desktop/startup-project/blog/moxixii-blog/package.json` start script to `NODE_ENV=production novel-isr start` if the unrelated local diff is still present.

**Interfaces:**
- Consumes the published GitHub Package version, never a workspace link, tarball, patch, override, or copied runtime.
- Leaves deployment to the existing business CI/CD workflow.

- [ ] **Step 1: Push the engine commits and verify CI**

Run:

```bash
git push origin main
ENGINE_CI_RUN_ID=$(gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$ENGINE_CI_RUN_ID" --exit-status
```

Expected: unit/integration, lint/type/build, and browser jobs all succeed.

- [ ] **Step 2: Tag the verified engine commit and watch publish**

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
PUBLISH_RUN_ID=$(gh run list --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$PUBLISH_RUN_ID" --exit-status
```

Expected: publish succeeds and the package registry reports the same version.

- [ ] **Step 3: Upgrade only the official package in the business repository**

Read `VERSION` from the verified engine `package.json`, then run `pnpm update "@novel-isr/engine@$VERSION" --save-exact` in `moxixii-blog`. Confirm `pnpm why @novel-isr/engine` resolves the registry package and that no `link:`, `file:`, `patch:`, or override exists.

- [ ] **Step 4: Restore the production start contract**

Ensure the consumer script is:

```json
"start": "NODE_ENV=production novel-isr start"
```

This is unrelated to development CSS but restores the engine-documented production startup behavior.

- [ ] **Step 5: Verify the business project locally**

Run:

```bash
pnpm run type-check
pnpm run test
pnpm run build
pnpm run dev
```

Against the running official package, execute the same hard-refresh, all-route navigation, rapid-navigation, and HMR frame sampler. Expected: no empty `--route-style-ready` frame and no console/runtime error.

- [ ] **Step 6: Commit and push the business upgrade**

Commit only the package version, lockfile, and intentional start-script restoration. Push the current branch and use `gh run watch` to verify the business CI/CD workflow. Do not manually inspect or modify deployment pods.

- [ ] **Step 7: Record final evidence**

Report engine commit/tag/version, engine CI and publish run results, consumer commit, business CI result, exact local verification commands, and browser temporal-test counts.
