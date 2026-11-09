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

export interface HtmlRouteDeclarationOptions {
  /** Matching rules are valid configuration, but are never concrete SSG pages. */
  allowPatterns?: boolean;
}

export function isHtmlRoutePattern(route: string): boolean {
  return route.includes('*') || route.split('/').some(segment => segment.startsWith(':'));
}

/** Validate the original declaration before a URL parser can repair or normalize it. */
export function htmlRouteIdentity(
  route: string,
  { allowPatterns = false }: HtmlRouteDeclarationOptions = {}
): string {
  const invalid = (reason: string) =>
    new Error(`Invalid HTML route ${JSON.stringify(route)}: ${reason}`);
  if (typeof route !== 'string') throw invalid('expected a path string');
  if (allowPatterns && route === '*') return route;
  const syntax = allowPatterns ? /^\/[A-Za-z0-9%\-._~/*:]*$/ : /^\/[A-Za-z0-9%\-._~/]*$/;
  if (!syntax.test(route) || route.startsWith('//'))
    throw invalid(
      'expected one origin-relative, percent-encoded pathname without query or fragment'
    );
  const segments = route.slice(1).split('/');
  if (segments.at(-1) === '') segments.pop();
  if (segments.some(segment => !segment)) throw invalid('empty path segment');
  let identity: string;
  try {
    identity = decodeHtmlPathname(route);
  } catch (cause) {
    throw new Error(`Invalid HTML route ${JSON.stringify(route)}: malformed or unsafe pathname`, {
      cause,
    });
  }
  if (
    Array.from(identity).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw invalid('control characters are forbidden');
  return identity;
}

/** Exact duplicates are idempotent; matching rules do not own concrete page identities. */
export function assertDistinctHtmlRouteIdentities(
  routes: Iterable<string>,
  options: HtmlRouteDeclarationOptions = {}
): void {
  const owners = new Map<string, string>();
  for (const route of routes) {
    const identity = htmlRouteIdentity(route, options);
    if (options.allowPatterns && isHtmlRoutePattern(route)) continue;
    const owner = owners.get(identity);
    if (owner !== undefined && owner !== route) {
      throw new Error(
        `Route identity collision: ${JSON.stringify(owner)} and ${JSON.stringify(route)} resolve to ${JSON.stringify(identity)}`
      );
    }
    owners.set(identity, route);
  }
}
