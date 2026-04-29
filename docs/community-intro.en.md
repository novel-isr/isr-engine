# Community pitch — English variants

> Three different lengths for three venues. Pick the one that matches where you're posting.
> Tone: looking for feedback, not announcing a product. Humble > polished.

---

## Variant A — Discord (Vite, plugin-rsc, or React community)

**~5 lines, paste in #general or #help. Link to the GitHub repo. Don't @ anyone.**

```
Built an ISR / SSG / fallback orchestration layer on top of @vitejs/plugin-rsc
(Vite 8 + React 19 + Express 5). Doesn't reimplement Flight — just adds
cacheTag / revalidatePath / SSG spider / csr-shell fallback / SEO / i18n.

Verified zero-config on a fresh consumer (`pnpm install` → `pnpm dev` works
with three files: vite.config.ts, package.json, src/app.tsx).

Currently alpha, only one project burning it in. Would love a sanity check
from anyone who has opinions on Vite RSC architecture — am I doing the right
thing or reinventing something Waku/RR7/TanStack already solved?

Repo: <link>
```

> If asked follow-ups, link to the longer RFC (Variant C) or to specific
> sections of the README.

---

## Variant B — Twitter / X / Mastodon

**Single message, 280 chars. For visibility, not recruitment.**

```
Built a Vite 8 + React 19 RSC orchestration layer on top of @vitejs/plugin-rsc:
ISR cache (LRU + Redis), SSG spider, csr-shell fallback, cacheTag invalidation.

Zero-config consumer side. alpha, looking for review.

<repo link>
```

---

## Variant C — GitHub Discussions on `vitejs/vite` or `vitejs/vite-plugin-react`

**RFC-style. Use the "Show and tell" or "Ideas" category, NOT "Help".**

### Title

> RFC: ISR / SSG / Fallback orchestration layer on top of `@vitejs/plugin-rsc` — looking for architectural feedback

### Body

```markdown
## What I built

`@novel-isr/engine` — a Vite 8 + React 19 RSC site orchestration layer that
sits on top of [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc).
It does **not** reimplement the Flight protocol or any RSC primitives — those
are entirely delegated to the official plugin.

What the engine adds:

- **ISR cache layer** — L1 in-process LRU + optional L2 Redis (write-through),
  TTL + SWR + tag-based invalidation (`cacheTag('books')` + `revalidateTag('books')`),
  single-flight thundering herd protection.
- **SSG spider** — build-time pre-render to `dist/client/<path>/index.html`,
  served at runtime via `express.static`.
- **`csr-shell` fallback chain** — when SSR rendering throws, the engine
  ships a minimal HTML shell + `self.__NO_HYDRATE=1` so the browser falls back
  to `createRoot` and refetches `_.rsc` to self-heal. Conceptually similar to
  GitHub's "unicorn page" or Twitter's "fail whale", but applied to the SSR layer.
- **Declarative SiteHooks** — pattern → meta or `{endpoint, transform}` for SEO
  and i18n, both as built-in concerns.
- **Express 5 host** — single process, hackable middleware chain, with built-in
  rate limiter, A/B variant cookie, Helmet, prom-client metrics.

The whole thing is consumed via three files in the user's project:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';
export default defineConfig({ plugins: [...createIsrPlugin()] });
```

```jsonc
// package.json scripts
{ "dev": "novel-isr dev", "build": "vite build", "start": "novel-isr start" }
```

```tsx
// src/app.tsx — the only required application file
import { parseLocale } from '@novel-isr/engine/runtime';
import { routes } from './routes';
export function App({ url }: { url: URL }) {
  return <html><body>{routes({ pathname: url.pathname, searchParams: url.searchParams })}</body></html>;
}
```

I just verified on a clean scaffold: `pnpm install && pnpm dev` works with
zero extra Vite configuration. No `optimizeDeps.include` workaround, no sass
dependency, no `pnpm.overrides`.

## Why I'm posting

This is **alpha**. One project (the originating site) is using it. 543 unit/
integration tests on the Node side, but no browser e2e yet. I'm not announcing
a product — I'm asking the Vite community to check whether I'm doing the
right thing.

## Five specific architectural questions I'd love feedback on

1. **Is "ISR cache as Express middleware" the right shape on Vite 8?**
   Vite 8 introduced the environments API. My ISR cache is currently a
   classic Express + Vite middleware-mode setup — should it migrate to
   environments / runtime API, or is ISR (with persistent connections to
   Redis, middleware chain) a legitimate exception?

2. **Routing: I rolled my own ~70-line `defineRoutes` because RR7 / TanStack
   Router / Waku's router all assume client-mounted hooks; the RSC
   `async Server Component` model didn't compose with their APIs.** Is
   there a cleaner RSC-native router I missed? Should this live in
   plugin-rsc upstream?

3. **`csr-shell` fallback as a concept** — when SSR throws, return a shell
   instead of 5xx, let the browser self-heal via `createRoot` + `_.rsc`
   refetch. I made up the term. Is there prior art (RFC, paper, Next/Remix
   internal pattern) I should look at? Are there logical holes in the
   degradation chain `isr → cached → regenerate → server → csr-shell`?

4. **Subpath exports that point to source `.tsx`** — `./client-entry`
   `./server-entry` `./runtime` had to ship as raw `.tsx` because:
   - `defineClientEntry` depends on `@vitejs/plugin-rsc/browser`'s virtual
     module (`virtual:vite-rsc/client-references`), only resolvable in the
     consumer's plugin-rsc context.
   - `runtime/index.ts` re-exports modules with module-level `'use client'`
     directives, which Rollup loses when bundled.

   This caused a real consumer-side bug: Vite's `optimizeDeps` scanner
   doesn't follow `file://` URL aliases into source files, so React itself
   wasn't pre-bundled and the browser hit `does not provide an export named
   'default' / 'jsxDEV'`. I worked around it by injecting
   `optimizeDeps.include` from inside the plugin, but **does plugin-rsc
   have a recommended pattern for libraries that need to preserve
   per-file `'use client'` semantics across a bundle boundary?**

5. **Is Express 5 still the right host in 2026?** I just upgraded from 4
   (which let me drop a `pnpm.overrides path-to-regexp@<0.1.13` hack). The
   alternative would be hono / itty-router / elysia — but Express 5 with
   path-to-regexp 6 is clean now, and the middleware ecosystem is mature.
   Curious what the Vite community thinks.

## What "honest current state" looks like

| Aspect | Status |
|---|---|
| Dev experience | Vite 8 HMR, zero-config consumer side (verified on cold install) |
| RSC protocol | Fully delegated to `@vitejs/plugin-rsc@^0.5.24`, follows upstream |
| ISR cache | L1 + L2 + tag invalidation + single-flight + OOM protection |
| SSG | Build-time spider, runtime `express.static` direct serving |
| Tests | 543 unit/integration (vitest), ~50% coverage |
| Browser e2e | **None yet**, manual smoke tests + curl |
| Burned in across multiple projects | **No**, only the originating project uses it |
| Public npm | No, GitHub Packages restricted (early review only) |
| API stability | alpha; pre-1.0 may have BREAKING changes |
| Bench data | Single-machine MacBook M-series, ±60% variance on GitHub runners — informational only, doesn't gate releases |

## What I'm hoping to get back

1. A high-level sanity check — should this exist alongside Waku / Next.js
   App Router, or am I missing why those already cover the niche?
2. Architectural blind spots — places where the design is going to bite
   me at the 100x-traffic point.
3. Vite 8 environments / runtime API migration advice — is the Express
   middleware path going to be obsolete in two years?
4. Anyone willing to take a real workload and burn it in.
5. A signal from `@vitejs/plugin-rsc` maintainers on whether ISR / SSG /
   fallback should converge into the official plugin or stay an
   ecosystem concern.

## Caveats I want to set up front

- The npm scope name `@novel-isr` comes from the originating project codename.
  There is **no business coupling** in the engine source — grep verified.
  Renaming the scope is a cost I haven't paid yet; please don't let the name
  bias the review.
- I am not pitching this as a Next.js replacement. If your stack is happy on
  Next, this isn't for you.
- I am not asking for stars. I am asking for review.

Repo: <link>
```

---

## Variant D — One-line "drop in a thread"

For replying to someone else's RSC discussion:

```
We tackled the same problem differently — built an ISR/SSG layer on top of
@vitejs/plugin-rsc (alpha, looking for review): <link>. Curious what you
think of putting the cache layer in Express middleware vs migrating to
Vite 8 environments API.
```

---

## What NOT to do (lessons from "show and tell" mistakes I've seen)

- Don't open with "I built an alternative to Next.js." It's both inaccurate
  (you're below Next, not next to it) and triggers tribal defense reactions.
- Don't post the README. The README is for users; the community pitch is for
  reviewers. Different audiences.
- Don't ask "is anyone interested?" Ask **specific architectural questions**.
  Open-ended posts get sympathy upvotes but no real review.
- Don't @ patak / Evan / Hiroshi on day one. Let the post stand on its own;
  if it's good, it'll travel organically.
- Don't follow up with "bump" comments. If it doesn't get traction in 48
  hours, the post needs editing, not bumping.

---

## After posting — engagement guidance

- Reply within 24 hours to every substantive comment. Even "thanks, I disagree
  because X" is better than silence.
- When someone points out a real flaw, **fix it that day**, push the fix,
  link the commit in the thread. This is the highest-leverage signal that
  you're serious.
- If someone says "this is just <existing project>" — actually read that
  project, then respond with concrete differences, not "yes but mine is better".
- If a maintainer of plugin-rsc / Vite shows up, listen more than you talk.
  They've seen 10 RFCs like this; one extra paragraph from them is worth
  20 from random users.
