const TRANSPORT_QUERY_KEYS = new Set(['direct', 't', 'v', 'import']);

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function canonicalizeDevStyleId(value: string, baseUrl = 'http://novel-isr.local/'): string {
  const decoded = decodeURIComponentSafely(value).replaceAll('\\', '/');
  const url = new URL(decoded, baseUrl);
  for (const key of TRANSPORT_QUERY_KEYS) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

export function styleIdsMatch(left: string, right: string, baseUrl?: string): boolean {
  const a = canonicalizeDevStyleId(left, baseUrl);
  const b = canonicalizeDevStyleId(right, baseUrl);
  return a === b || a.endsWith(b) || b.endsWith(a);
}
