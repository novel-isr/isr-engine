const RSC_POSTFIX = '_.rsc';

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
      null,
      '',
      `${final.pathname}${final.search}${browserWindow.location.hash}`
    );
  } catch {
    // Invalid/cross-origin history targets must not break an accepted RSC tree.
  } finally {
    internalNavigationHistoryMutationDepth -= 1;
  }
}
