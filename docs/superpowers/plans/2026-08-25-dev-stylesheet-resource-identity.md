# Dev Stylesheet Resource Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every development SSR stylesheet emitted through the RSC CSS resource pipeline has a stable CSS-only URL before first paint.

**Architecture:** Extend the existing engine-owned dev stylesheet integration plugin at the `virtual:vite-rsc/css` module boundary. Canonicalize only stylesheet href literals to Vite's public `direct` resource identity; leave JavaScript CSS-module imports untouched and retain the existing SSR-to-Vite atomic handoff.

**Tech Stack:** TypeScript, Vite 8 plugin hooks, `@vitejs/plugin-rsc`, Vitest, React 19 RSC.

**Spec:** User-approved design in the 2026-08-25 conversation: engine-only, first-principles fix with no business-side implementation or timing workaround.

## Global Constraints

- Do not add stylesheet bootstrapping, preload logic, or DOM timing patches to a consumer application.
- Development SSR stylesheet URLs and JavaScript CSS-module URLs must have distinct resource identities.
- Production asset URLs and non-CSS literals must remain unchanged.
- Do not publish until the full engine checks, build, HTTP resource assertions, and untouched consumer verification pass.

---

### Task 1: Canonical RSC Stylesheet Identity

**Files:**
- Modify: `src/plugin/createDevCssHandoffPlugin.ts`
- Modify: `src/plugin/__tests__/createDevCssHandoffPlugin.test.ts`

**Interfaces:**
- Consumes: Vite transform input for resolved `\0virtual:vite-rsc/css?...` modules.
- Produces: `canonicalizeDevRscStylesheetModule(code: string, id: string)` and transformed module source whose CSS hrefs contain the `direct` query flag.

- [ ] **Step 1: Write a failing test for virtual RSC CSS modules**

Assert that CSS href literals gain `?direct`, existing query parameters gain `&direct`, already-direct URLs are unchanged, and React imports or ordinary modules are untouched.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/plugin/__tests__/createDevCssHandoffPlugin.test.ts`

Expected: FAIL because the canonicalization behavior does not exist.

- [ ] **Step 3: Implement the minimal AST-based canonicalization**

Parse only the plugin-rsc virtual CSS module, replace only CSS-family URL string literals, and return a Vite transform result only when source changes.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/plugin/__tests__/createDevCssHandoffPlugin.test.ts`

Expected: PASS.

### Task 2: End-to-End Development Resource Contract

**Files:**
- Create: `src/plugin/__tests__/devStylesheetIdentity.integration.test.ts`

**Interfaces:**
- Consumes: `createIsrPlugin()` and a temporary Vite/RSC fixture.
- Produces: HTTP evidence that SSR stylesheet hrefs use `direct`, return `text/css`, and the bare module URL still returns JavaScript.

- [ ] **Step 1: Write the development-server integration test**

Create a temporary consumer fixture with a CSS module, start Vite on an ephemeral port, request the SSR HTML and both resource identities, and assert their content types.

- [ ] **Step 2: Run the integration test and verify behavior**

Run: `pnpm vitest run src/plugin/__tests__/devStylesheetIdentity.integration.test.ts`

Expected: PASS only when the resource contract is correct end to end.

### Task 3: Release And Consumer Verification

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify after publication: `../../../blog/moxixii-blog/package.json`
- Modify after publication: `../../../blog/moxixii-blog/pnpm-lock.yaml`

**Interfaces:**
- Consumes: a passing engine build and published GitHub Packages version.
- Produces: a tagged engine release and a consumer using the official package without business-side style code.

- [ ] **Step 1: Verify the engine**

Run: `pnpm run check && pnpm run build`

- [ ] **Step 2: Update release metadata, commit, push, and tag**

Use the next patch version, push `main` and its tag, then inspect GitHub Actions until publication succeeds.

- [ ] **Step 3: Upgrade the consumer from the official registry**

Update only the engine dependency and lockfile. Preserve the user's existing unrelated `start` script modification.

- [ ] **Step 4: Verify the untouched consumer**

Run its tests, type check, build, and development HTTP assertions. Confirm generated SSR stylesheet URLs use `direct` and return `text/css` before committing and pushing the dependency upgrade.
