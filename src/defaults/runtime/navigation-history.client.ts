const RSC_POSTFIX = '_.rsc';
const entryStateKey = '__isr_scroll_entry';
let nextLegacyEntry = 0;

let internalNavigationHistoryMutationDepth = 0;

interface BrowserHistoryTarget {
  history: History;
  location: Location;
}

interface ResponseLocation {
  url: string;
}

interface BusinessLocation {
  origin: string;
  pathname: string;
  search: string;
}

function businessLocation(urlString: string): BusinessLocation | undefined {
  try {
    const url = new URL(urlString);
    return {
      origin: url.origin,
      pathname: url.pathname.endsWith(RSC_POSTFIX)
        ? url.pathname.slice(0, -RSC_POSTFIX.length)
        : url.pathname,
      search: url.search,
    };
  } catch {
    return undefined;
  }
}

function sameBusinessLocation(left: BusinessLocation, right: BusinessLocation): boolean {
  return (
    left.origin === right.origin && left.pathname === right.pathname && left.search === right.search
  );
}

export function isInternalNavigationHistoryMutation(): boolean {
  return internalNavigationHistoryMutationDepth > 0;
}

function navigationEntryKey(): string | undefined {
  return (window as Window & { navigation?: { currentEntry?: { key: string } } }).navigation
    ?.currentEntry?.key;
}

export function pushLinkNavigation(href: string): void {
  window.history.pushState(null, '', href);
}

type ScrollPosition = [x: number, y: number];
export type HistoryChange = 'push' | 'replace' | 'traverse' | 'hash';

function currentScrollEntry(): string {
  return navigationEntryKey() ?? legacyEntryKey() ?? window.location.href;
}

function legacyEntryKey(): string | undefined {
  const value: unknown = window.history.state?.[entryStateKey];
  return typeof value === 'string' ? value : undefined;
}

export function historyStateWithScrollEntry(data: unknown, replace: boolean): unknown {
  if (
    navigationEntryKey() ||
    (data != null && (typeof data !== 'object' || Object.getPrototypeOf(data) !== Object.prototype))
  ) {
    return data;
  }
  // Preserve application fields and use the browser's entry key wherever available.
  return {
    ...(data as Record<string, unknown> | null),
    [entryStateKey]:
      (replace ? legacyEntryKey() : undefined) ?? performance.timeOrigin + ':' + ++nextLegacyEntry,
  };
}

function fragmentTarget(hash: string): HTMLElement | undefined {
  const raw = hash.slice(1);
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // The literal fragment can still be a valid element ID.
  }
  return (
    document.getElementById(name) ??
    Array.from(document.getElementsByName(name)).find(element => element.localName === 'a')
  );
}

export function createNavigationScroll() {
  const { history } = window;
  const previousRestoration = history.scrollRestoration;
  history.scrollRestoration = 'manual';
  if (!navigationEntryKey() && !legacyEntryKey()) {
    const existing = history.state;
    const state = historyStateWithScrollEntry(existing, true);
    if (state !== existing) history.replaceState(state, '');
  }

  const positions = new Map<string, ScrollPosition>();
  let entry = currentScrollEntry();
  let pending: { restore?: ScrollPosition } | undefined;
  let stopWaiting: (() => void) | undefined;
  let scheduledScroll: number | undefined;

  function save() {
    if (!pending) positions.set(entry, [window.scrollX, window.scrollY]);
  }

  function apply(restore?: ScrollPosition) {
    stopWaiting?.();
    const { hash } = window.location;
    function tryScroll(): boolean {
      if (restore) {
        window.scrollTo({ left: restore[0], top: restore[1], behavior: 'instant' });
        return (
          Math.abs(window.scrollX - restore[0]) < 1 && Math.abs(window.scrollY - restore[1]) < 1
        );
      }
      const target = hash ? fragmentTarget(hash) : undefined;
      if (!target) return false;
      target.scrollIntoView({ behavior: 'instant' });
      return true;
    }
    if (tryScroll()) return;
    if (!restore) {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      if (!hash || hash.toLowerCase() === '#top') return;
    }

    // Streamed content can mount an anchor or make saved coordinates reachable later.
    const waiting = new AbortController();
    stopWaiting = () => waiting.abort();
    const retry = () => {
      if (tryScroll()) waiting.abort();
    };
    const mutations = new MutationObserver(retry);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: !restore,
      ...(restore ? {} : { attributeFilter: ['id', 'name'] }),
    });
    const resize =
      restore && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(retry) : undefined;
    resize?.observe(document.body);
    waiting.signal.addEventListener(
      'abort',
      () => {
        mutations.disconnect();
        resize?.disconnect();
        stopWaiting = undefined;
      },
      { once: true }
    );
    for (const type of ['pointerdown', 'wheel', 'keydown']) {
      window.addEventListener(type, stopWaiting, { passive: true, signal: waiting.signal });
    }
  }

  window.addEventListener('scroll', save, { passive: true });
  return {
    save,
    changed(kind: HistoryChange, needsPayload: boolean): (() => void) | undefined {
      const nextEntry = currentScrollEntry();
      const restore = kind === 'traverse' ? positions.get(nextEntry) : undefined;
      const entryChanged = nextEntry !== entry;
      if (entryChanged || needsPayload || kind === 'hash') {
        stopWaiting?.();
        if (scheduledScroll !== undefined) window.cancelAnimationFrame(scheduledScroll);
        scheduledScroll = undefined;
      }
      entry = nextEntry;
      if (!needsPayload) {
        if (pending && entryChanged) pending.restore = restore;
        else if (entryChanged && restore) {
          scheduledScroll = window.requestAnimationFrame(() => {
            scheduledScroll = undefined;
            if (!pending && currentScrollEntry() === nextEntry) apply(restore);
          });
        }
        return undefined;
      }
      const transition = { restore };
      pending = transition;
      return () => {
        if (pending !== transition) return;
        pending = undefined;
        entry = currentScrollEntry();
        apply(transition.restore);
      };
    },
    dispose() {
      window.removeEventListener('scroll', save);
      stopWaiting?.();
      if (scheduledScroll !== undefined) window.cancelAnimationFrame(scheduledScroll);
      pending = undefined;
      history.scrollRestoration = previousRestoration;
    },
  };
}

/**
 * Synchronize an accepted server redirect without re-entering the RSC router.
 * A completed non-redirect response, or a redirect for a location the user has
 * already left, must never rewrite browser history.
 */
export function syncBrowserUrlToFinalRedirect(
  response: ResponseLocation,
  requestedUrl: string,
  browserWindow: BrowserHistoryTarget = window
): void {
  if (!response.url) return;
  const requested = businessLocation(requestedUrl);
  const final = businessLocation(response.url);
  const current = businessLocation(browserWindow.location.href);
  if (!requested || !final || !current) return;

  // No route change on the wire means this was an ordinary response, even if a
  // newer navigation has changed window.location while it was in flight.
  if (sameBusinessLocation(requested, final)) return;

  // Only the navigation that still owns the address bar may apply its redirect.
  if (!sameBusinessLocation(current, requested) || final.origin !== current.origin) return;

  internalNavigationHistoryMutationDepth += 1;
  try {
    browserWindow.history.replaceState(
      browserWindow.history.state ?? null,
      '',
      `${final.pathname}${final.search}${browserWindow.location.hash}`
    );
  } catch {
    // Invalid/cross-origin history targets must not break an accepted RSC tree.
  } finally {
    internalNavigationHistoryMutationDepth -= 1;
  }
}
