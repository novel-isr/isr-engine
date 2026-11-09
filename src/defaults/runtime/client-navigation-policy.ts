export interface PrefetchConnection {
  saveData?: boolean;
  effectiveType?: string;
}

export function isRscNavigation(href: string, current: string): boolean {
  try {
    const url = new URL(href, current);
    const from = new URL(current);
    return (
      /^https?:$/.test(url.protocol) &&
      url.origin === from.origin &&
      (url.pathname !== from.pathname || url.search !== from.search)
    );
  } catch {
    return false;
  }
}

export function shouldPrefetch(
  href: string,
  current: string,
  policy: string | undefined,
  reason: 'intent' | 'viewport',
  connection?: PrefetchConnection
): boolean {
  return (
    isRscNavigation(href, current) &&
    policy !== 'false' &&
    !(reason === 'viewport' && policy === 'intent') &&
    !connection?.saveData &&
    !['slow-2g', '2g'].includes(connection?.effectiveType ?? '')
  );
}

export function createPrefetcher(
  request: (url: string) => Promise<{ ok: boolean }>,
  limit = 128
): (href: string) => Promise<void> {
  const completed = new Set<string>();
  const pending = new Set<string>();
  return async href => {
    let key: string;
    try {
      const url = new URL(href);
      url.hash = '';
      url.pathname += '_.rsc';
      key = url.href;
    } catch {
      return;
    }
    if (completed.has(key) || pending.has(key) || pending.size >= limit) return;
    pending.add(key);
    try {
      const response = await request(key);
      if (response.ok) {
        completed.add(key);
        if (completed.size > limit) completed.delete(completed.values().next().value!);
      }
    } catch {
      // Speculation must never reject into the navigation or event-handler path.
      // Failed requests are deliberately not remembered so later intent can retry.
    } finally {
      pending.delete(key);
    }
  };
}
