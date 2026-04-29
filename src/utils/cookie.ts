export type CookieHeaderSource =
  | string
  | null
  | undefined
  | {
      headers?: Headers | Record<string, string | string[] | number | undefined | null>;
    };

export function getCookieHeader(source: CookieHeaderSource): string {
  if (!source) return '';
  if (typeof source === 'string') return source;

  const headers = source.headers;
  if (!headers) return '';

  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('cookie') ?? '';
  }

  const record = headers as Record<string, string | string[] | number | undefined | null>;
  const raw = record.cookie ?? record.Cookie;
  if (Array.isArray(raw)) return raw.join('; ');
  return raw === undefined || raw === null ? '' : String(raw);
}

export function readCookie(source: CookieHeaderSource, name: string): string | undefined {
  if (!name) return undefined;
  const cookies = parseCookieHeader(getCookieHeader(source));
  return cookies[name];
}

export function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const index = trimmed.indexOf('=');
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    if (!key) continue;

    const rawValue = trimmed.slice(index + 1).trim();
    cookies[key] = safeDecodeCookieValue(rawValue);
  }

  return cookies;
}

function safeDecodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
