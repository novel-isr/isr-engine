import type { Response } from 'express';

const REDIRECT_ORIGIN = 'https://isr.invalid';

/** Validate the final Location value against a fixed origin, never an untrusted Host header. */
export function isSafeLocalRedirect(target: string): boolean {
  if (!target.startsWith('/') || target.startsWith('//')) return false;
  for (const character of target) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  const pathEnd = target.search(/[?#]/);
  if (target.slice(0, pathEnd < 0 ? undefined : pathEnd).includes('\\')) return false;
  try {
    return new URL(target, REDIRECT_ORIGIN).origin === REDIRECT_ORIGIN;
  } catch {
    return false;
  }
}

export function readRedirectQuery(url: string): string | undefined {
  const delimiter = url.indexOf('?');
  return delimiter < 0 ? undefined : url.slice(delimiter + 1);
}

export function redirectLocal(
  res: Response,
  status: 302 | 308,
  pathname: string,
  query?: string
): void {
  // Keep request query bytes in the query component, including a bare question mark.
  const target = query === undefined ? pathname : `${pathname}?${query}`;
  if (!isSafeLocalRedirect(target)) {
    res.status(400).end();
    return;
  }
  res.redirect(status, target);
}
