# Dev Config Double-Load Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the ISR dev server evaluates and registers a consumer's Vite configuration exactly once, then publish and verify the fixed engine version in `moxixii-blog`.

**Architecture:** `createViteDevServer()` remains responsible for explicitly loading and merging the consumer config. The resulting inline config must disable Vite's second config-file discovery so each RSC and ISR plugin instance is registered once. Verification uses an isolated packed-engine consumer before release and the officially published package after CI completes.

**Tech Stack:** TypeScript, Vite 8, React 19 RSC, Vitest 4, pnpm, GitHub Actions, GitHub CLI.

**Spec:** User request in the active Codex conversation on 2026-08-24.

## Global Constraints

- Do not patch `moxixii-blog/node_modules` or rely on a local link as the delivered fix.
- Commit and push the engine fix so the engine CI/CD performs the release.
- Query release status with `gh`, then install and verify the newly published version.
- Preserve unrelated user changes in both repositories.

---

### Task 1: Prevent duplicate Vite config evaluation

**Files:**
- Modify: `src/server/viteDevServer.ts`
- Test: `src/server/__tests__/viteDevServer.test.ts`

**Interfaces:**
- Consumes: Vite `loadConfigFromFile`, `mergeConfig`, and `createServer`.
- Produces: A final `InlineConfig` with `configFile: false` after explicit config loading.

- [x] **Step 1: Write the failing test**

Add a focused test that loads a consumer config through the existing function and asserts the final inline server config disables config-file discovery.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/__tests__/viteDevServer.test.ts`

Expected: FAIL because `configFile` is absent.

- [x] **Step 3: Write minimal implementation**

Add `configFile: false` to the engine-owned inline overrides passed to `createServer()`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/__tests__/viteDevServer.test.ts`

Expected: PASS.

### Task 2: Verify a single-package consumer before release

**Files:**
- No tracked files; use a temporary copy of `blog/moxixii-blog`.

**Interfaces:**
- Consumes: `pnpm pack` output from the fixed engine.
- Produces: Dev logs and HTML showing one plugin initialization, one cache write, and non-duplicated stylesheet links.

- [x] **Step 1: Build and pack the engine**

Run: `pnpm build && pnpm pack`

Expected: A local package archive containing the fixed CLI and runtime.

- [x] **Step 2: Install the archive in an isolated blog copy**

Create a temporary copy without `.git`, `node_modules`, caches, or build output; install the archive as its engine dependency.

- [x] **Step 3: Run the isolated blog dev server**

Run: `pnpm dev` in the isolated copy.

Expected: One ISR entry initialization, one cache backend initialization, and successful RSC SSR.

- [x] **Step 4: Inspect the rendered response**

Request `/` and compare stylesheet URLs and cache writes.

Expected: Stylesheets are not duplicated by repeated plugin registration.

### Task 3: Validate, commit, and publish

**Files:**
- Modify only the source, test, and this plan created by Task 1.

**Interfaces:**
- Consumes: Passing focused and full repository checks.
- Produces: A pushed commit and successful release workflow.

- [x] **Step 1: Run repository verification**

Run: `pnpm check && pnpm build`

Expected: Type-check, lint, tests, and build all pass.

- [ ] **Step 2: Review the final diff**

Run: `git diff --check && git diff -- src/server/viteDevServer.ts src/server/__tests__/viteDevServer.test.ts docs/superpowers/plans/2026-08-24-dev-config-double-load.md`

Expected: Only scoped changes with no whitespace errors.

- [ ] **Step 3: Commit and push**

Run: `git add ... && git commit -m "fix(dev): avoid loading Vite config twice" && git push origin main`

Expected: The engine repository accepts the commit on `main`.

- [ ] **Step 4: Track CI/CD**

Run: `gh run list`, then `gh run watch <run-id> --exit-status`.

Expected: The release workflow succeeds and publishes a new package version.

### Task 4: Consume and verify the released version

**Files:**
- Modify: `blog/moxixii-blog/package.json`
- Modify: `blog/moxixii-blog/pnpm-lock.yaml`

**Interfaces:**
- Consumes: The new published `@novel-isr/engine` version.
- Produces: A real blog installation and dev verification using only registry artifacts.

- [ ] **Step 1: Install the exact released version**

Run: `pnpm add @novel-isr/engine@<released-version>` in `blog/moxixii-blog`.

Expected: Package metadata and lockfile resolve to the released version, not a local path.

- [ ] **Step 2: Run blog checks and dev verification**

Run: `pnpm type-check`, `pnpm build`, and `pnpm dev` followed by an HTTP request to `/`.

Expected: Checks pass, RSC SSR succeeds, and plugin/style resources are registered once.

- [ ] **Step 3: Report final evidence**

Report the engine commit, workflow result, published version, blog dependency resolution, and verification commands.
