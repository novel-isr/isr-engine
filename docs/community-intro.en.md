# Community pitch — short English variants

---

## For Discord (Vite / plugin-rsc / Reactiflux)

```
Built an ISR / SSG layer on top of @vitejs/plugin-rsc — adds cacheTag,
revalidatePath, SSG spider, and a csr-shell fallback. Vite 8 + React 19 +
Express 5, doesn't reimplement Flight.

Alpha, one project using it. Would love a sanity check on the architecture
before I push it further. Repo: <link>
```

---

## For GitHub Discussions (vitejs/vite, "Show and tell" or "Ideas")

**Title:** `ISR / SSG layer on top of @vitejs/plugin-rsc — feedback welcome`

**Body:**

```markdown
Small project sitting on top of `@vitejs/plugin-rsc`: adds an ISR cache layer
(LRU + Redis, tag-based invalidation), an SSG spider, and a `csr-shell`
fallback for when SSR throws. Vite 8 + React 19 + Express 5. Doesn't
reimplement the Flight protocol — that's still the official plugin's job.

Consumer-side it's three files (`vite.config.ts`, `package.json`, `src/app.tsx`)
with zero extra Vite config.

It's alpha — only one site is using it. Posting here because I'd like a
review from people who know Vite RSC internals before I take it further.
Specific things I'd like opinions on:

1. ISR cache as Express middleware vs migrating to Vite 8 environments API
2. The `csr-shell` fallback concept (is there prior art?)
3. Subpath exports that ship as raw `.tsx` because plugin-rsc needs to see
   `'use client'` directives — is there a recommended pattern?
4. Where config validation belongs. v2.3.x earlier asked consumers to write
   their own `resolveRateLimitStore()`-style env sanitizer; engine silently
   fell back to `'memory'` on bad values. Just moved validation into the
   engine boundary (engine owns the `'memory' | 'redis' | 'auto'` union, so
   it should validate). Are there other config knobs in this codebase that
   I'm still leaking validation responsibility for?

Repo: <link>
Not pitching a Next.js replacement. Honestly looking for pushback.
```

---

## For X / Twitter

```
ISR / SSG layer on top of @vitejs/plugin-rsc. Vite 8 + React 19 + Express 5.
Doesn't reimplement Flight, just adds the cache + spider + fallback chain
on top. Alpha, looking for review.

<link>
```
