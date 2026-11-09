/** Shared logical identity for HTML dispatch, aliases and build-time route validation. */
export function decodeHtmlPathname(raw: string): string {
  const pathname = decodeURIComponent(raw);
  if (
    pathname.includes('\\') ||
    pathname.includes('\0') ||
    pathname.split('/').some(segment => segment === '..' || segment === '.')
  ) {
    throw new Error('Invalid HTML pathname');
  }
  return pathname;
}

/** Exact duplicate declarations are idempotent; distinct encodings cannot own one URL. */
export function assertDistinctHtmlRouteIdentities(routes: Iterable<string>): void {
  const owners = new Map<string, string>();
  for (const route of routes) {
    let identity: string;
    try {
      identity = decodeHtmlPathname(new URL(route, 'http://localhost').pathname);
    } catch {
      // Invalid routes retain their caller's validation/error policy.
      continue;
    }
    const owner = owners.get(identity);
    if (owner !== undefined && owner !== route) {
      throw new Error(
        `Route identity collision: ${JSON.stringify(owner)} and ${JSON.stringify(route)} resolve to ${JSON.stringify(identity)}`
      );
    }
    owners.set(identity, route);
  }
}
