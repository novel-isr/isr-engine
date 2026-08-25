export const DEV_STYLE_TRANSPORT_GENERATION_PARAM = '__novel_isr_style_generation';

const TRANSPORT_QUERY_KEYS = new Set([
  'direct',
  't',
  'v',
  'import',
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
]);

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

export function withDevStyleTransportGeneration(
  value: string,
  generation: number,
  baseUrl = 'http://novel-isr.local/'
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`Invalid development stylesheet generation: ${generation}.`);
  }
  const url = new URL(value, baseUrl);
  url.searchParams.set(DEV_STYLE_TRANSPORT_GENERATION_PARAM, String(generation));
  return /^[a-z][a-z\d+.-]*:/i.test(value)
    ? url.toString()
    : `${url.pathname}${url.search}${url.hash}`;
}

export function getDevStyleTransportGeneration(
  value: string,
  baseUrl = 'http://novel-isr.local/'
): number | undefined {
  const encoded = new URL(value, baseUrl).searchParams.get(DEV_STYLE_TRANSPORT_GENERATION_PARAM);
  if (encoded === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(encoded)) return undefined;
  const generation = Number(encoded);
  return Number.isSafeInteger(generation) ? generation : undefined;
}
