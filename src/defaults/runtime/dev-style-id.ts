export const DEV_STYLE_TRANSPORT_GENERATION_PARAM = '__novel_isr_style_generation';

const TRANSPORT_QUERY_KEYS = new Set([
  'direct',
  't',
  'v',
  'import',
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
]);

const UNRESERVED_PATH_BYTE = /^[A-Za-z\d._~-]$/;

function canonicalizePathname(pathname: string): string {
  return pathname.replace(/%([\da-f]{2})/gi, (_encoded, hex: string) => {
    const decoded = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_PATH_BYTE.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
  });
}

export function canonicalizeDevStyleId(value: string, baseUrl = 'http://novel-isr.local/'): string {
  const url = new URL(value, baseUrl);
  for (const key of TRANSPORT_QUERY_KEYS) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${canonicalizePathname(url.pathname)}${url.search}`;
}

export function styleIdsMatch(left: string, right: string, baseUrl?: string): boolean {
  return canonicalizeDevStyleId(left, baseUrl) === canonicalizeDevStyleId(right, baseUrl);
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

export function createDevStyleTransportHref(
  value: string,
  generation: number,
  baseUrl = 'http://novel-isr.local/'
): string {
  const canonical = canonicalizeDevStyleId(value, baseUrl);
  const url = new URL(canonical, baseUrl);
  url.searchParams.set('direct', '');
  return withDevStyleTransportGeneration(`${url.pathname}${url.search}`, generation, baseUrl);
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
