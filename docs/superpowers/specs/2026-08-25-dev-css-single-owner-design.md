# Dev CSS Single-Owner Lifecycle

## Problem

In Vite development, React/RSC stylesheet resources and Vite CSS-module runtime styles both mutate the document CSSOM. The current handoff removes an SSR stylesheet link as soon as a matching Vite style node appears. Vite can later prune that style node before reinserting its replacement, leaving a short interval with no active route stylesheet.

The failure is temporal: the initial HTML contains the required stylesheet links, and the final DOM is correct, but an intermediate HMR or RSC transition can expose unstyled content.

## Goals

- Keep at least one active stylesheet for every committed UI tree at every point in development.
- Give one engine-owned registry exclusive authority over development stylesheet DOM nodes after bootstrap.
- Make CSS replacement and route stylesheet changes transactional.
- Preserve React stylesheet suspension for the initial render and RSC navigation.
- Preserve Vite CSS HMR without requiring application code or configuration.
- Keep the production CSS path unchanged.

## Non-Goals

- Replacing Vite's CSS compiler or CSS Modules class-name generation.
- Adding an application-facing stylesheet API.
- Retaining obsolete route styles after a transition has committed.
- Changing production asset generation or caching.

## Ownership Model

Each stylesheet has a stable canonical identifier derived from its resolved Vite module identity with transport-only query parameters removed. Query parameters that change stylesheet semantics remain part of the identifier.

The engine development runtime maintains one record per identifier:

```ts
type DevStyleState =
  | 'ssr-active'
  | 'client-active'
  | 'updating'
  | 'pending-release'
  | 'released';
```

An SSR `link` is the bootstrap owner. After the client publishes compiled CSS, the engine registry becomes the only owner. Vite supplies compiled content and lifecycle signals but does not independently create or remove stylesheet DOM nodes.

The invariant is:

> A stylesheet used by the currently committed React tree always has an active SSR link or an engine-managed style node.

## Bootstrap

The server emits each development client-reference stylesheet as a direct CSS link with its canonical identifier in a data attribute. React retains responsibility for waiting for those links before revealing the relevant boundary.

The client registry adopts these links without removing them. When a CSS module publishes compiled content, the registry:

1. Creates or synchronously updates the engine-owned style node.
2. Verifies that the style node is connected and contains the published version.
3. Removes the matching SSR link.
4. Marks the record `client-active`.

The new owner is installed before the old owner is released. There is no state transition through an empty owner set.

## Vite Integration

An engine-owned Vite plugin integrates at the CSS module output boundary. In development it redirects Vite's generated CSS side effects to the registry:

```ts
devStyleRegistry.publish(styleId, cssText, import.meta.hot);
```

CSS Modules exports remain unchanged. The integration must use parsed module structure or a supported Vite/plugin-rsc hook; it must not depend on unvalidated string replacement.

The generated module registers lifecycle callbacks with the registry instead of calling Vite's DOM-level `updateStyle` and `removeStyle` functions directly.

If the installed Vite/plugin-rsc version does not expose a stable interception point, the engine will pin the compatible dependency range and validate the transformed module shape at startup. An unknown shape fails loudly in development instead of silently reverting to dual ownership.

## Update Transactions

The registry groups HMR and RSC changes into transactions.

### CSS HMR

On `vite:beforeUpdate`, affected records enter `updating` but retain their current CSS. A subsequent publish replaces `textContent` on the existing engine-owned style node and returns the record to `client-active`. The node is never removed during an update.

On `vite:afterUpdate`, records not republished are reconciled against the active module/style set. Only styles proven unused may be released.

### Module Prune

A prune signal changes a record to `pending-release`; it never removes CSS immediately. If the module is republished in the same transaction, release is cancelled. Otherwise, removal occurs only after the transaction commits and the style is absent from the committed RSC stylesheet set.

### RSC Navigation

The next RSC payload declares the stylesheet identifiers required by the pending tree. React loads new SSR links before revealing that tree. After React commits the new tree, the registry reconciles the previous and next identifier sets:

- shared styles remain active;
- new styles are adopted or published before commit;
- removed styles are released after commit.

An aborted navigation discards its pending style set and preserves the current committed set.

## Runtime Boundary

The registry and transaction bridge are engine defaults initialized by the generated client entry. Applications continue to use normal CSS/SCSS imports and `novel-isr dev`; no business component, provider, hook, runtime import, or configuration is introduced.

The current mutation-observer handoff is removed after the registry path is active. `?direct` stylesheet URLs remain because they provide the correct CSS transport identity, but they no longer define ownership.

## Failure Handling

- A publish without a canonical identifier throws a development error with the originating module id.
- Conflicting content for the same identifier and version is reported and the last committed CSS remains active.
- An unrecognized Vite CSS wrapper fails startup compatibility validation.
- Transaction timeout diagnostics report pending style ids but do not remove their last active CSS.
- Development diagnostics are excluded from production bundles.

## Testing

### Unit Tests

- Canonical identifier normalization, including `?direct`, timestamps, CSS Modules, and semantic queries.
- Bootstrap adoption installs the engine style before removing the SSR link.
- Publish updates an existing node without remove/recreate.
- Prune followed by republish never removes the active style.
- Prune without republish releases only after transaction and committed-set reconciliation.
- Aborted transactions preserve the previous committed style set.
- Registry cleanup is idempotent.

### Integration Tests

- Generated development CSS modules use the registry and preserve CSS Modules exports.
- Unknown Vite output shapes fail compatibility validation.
- Initial HTML contains direct stylesheet links before body content.
- RSC navigation publishes the next style set before releasing the previous set.
- Production output does not include the development registry.

### Browser Tests

Run a real Vite development server and sample computed styles on every animation frame during:

- hard refresh and hydration;
- navigation between routes with disjoint styles;
- rapid repeated navigation;
- CSS-only HMR;
- component HMR that prunes and reimports CSS;
- removal of a route stylesheet;
- failed and aborted RSC navigation.

Each test asserts that a sentinel element for the committed tree never falls back to its unstyled value. Tests also assert that obsolete route rules disappear after commit and that only one engine-owned client style node exists per canonical identifier.

## Release And Consumer Verification

The change is released as a new engine version through the existing CI/CD workflow. A consumer verifies the published package without local links, patches, overrides, or copied runtime code. The business repository changes only its engine version and lockfile, then runs its existing type checks, tests, build, and development browser regression suite.

## Acceptance Criteria

- No observable unstyled frame during refresh, hydration, RSC navigation, CSS HMR, or module prune.
- No duplicate client-owned stylesheet nodes for one canonical identifier after bootstrap.
- No stale route CSS after a successful transition.
- No business-side lifecycle implementation.
- Existing engine unit, integration, type-check, lint, and build suites pass.
- New real-browser temporal tests fail against the current handoff and pass against the registry implementation.
