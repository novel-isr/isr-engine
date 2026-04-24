import { createHash } from 'node:crypto';

interface HeaderCarrier {
  setHeader(name: string, value: string): void;
  status?: (code: number) => void;
  statusCode?: number;
}

export interface RenderHeadersInput {
  mode: string;
  strategy: string;
  renderTime: number;
  html: string;
  cacheHit?: boolean;
  fallbackUsed?: boolean;
  statusCode?: number;
  cacheTTL?: number;
  revalidateAt?: number;
  route?: string;
}

export interface RenderHeadersResult {
  etag: string;
  cacheControl: string;
  isNotModified: boolean;
}

export function computeRenderCacheControl(
  mode: string,
  cacheHit: boolean,
  options?: { cacheTTL?: number }
): string {
  const ttl = Math.max(1, options?.cacheTTL ?? 3600);

  switch (mode) {
    case 'ssr':
      return 'no-store, max-age=0, must-revalidate';
    case 'ssg':
      return `public, max-age=${ttl}, immutable`;
    case 'isr':
      return cacheHit
        ? `public, max-age=0, must-revalidate, stale-while-revalidate=${ttl}`
        : 'public, max-age=0, must-revalidate';
    default:
      return 'no-cache, max-age=0, must-revalidate';
  }
}

function normalizeEtags(rawHeader: string | string[] | undefined): string[] {
  if (!rawHeader) {
    return [];
  }

  const source = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;
  return source
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function setRenderResponseHeaders(
  res: HeaderCarrier,
  reqHeaders: Record<string, string | string[] | undefined> | undefined,
  input: RenderHeadersInput
): RenderHeadersResult {
  const {
    mode,
    strategy,
    renderTime,
    html,
    cacheHit = false,
    fallbackUsed = false,
    statusCode = 200,
    cacheTTL,
    revalidateAt,
    route,
  } = input;

  const cacheControl = computeRenderCacheControl(mode, cacheHit, { cacheTTL });
  const etagSeed = `${mode}|${strategy}|${cacheHit ? 'hit' : 'miss'}|${html.length}|${route || ''}`;
  const etag = `W/"${createHash('sha1').update(etagSeed).digest('hex')}"`;

  res.setHeader('X-Render-Mode', mode);
  res.setHeader('X-ISR-Mode', mode);
  res.setHeader('X-Render-Strategy', strategy);
  res.setHeader('X-Render-Time', `${renderTime}ms`);
  res.setHeader('X-Cache-Status', cacheHit ? 'HIT' : 'MISS');
  res.setHeader('X-Fallback-Used', fallbackUsed ? 'true' : 'false');
  res.setHeader('X-Render-Route', route || '*');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Vary', 'Accept-Encoding, Accept, User-Agent');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date().toUTCString());

  if (mode === 'isr' && typeof revalidateAt === 'number') {
    res.setHeader('X-Revalidate-After', String(revalidateAt));
  }

  const ifNoneMatchHeader =
    reqHeaders?.['if-none-match'] || reqHeaders?.['If-None-Match'] || reqHeaders?.['IF-NONE-MATCH'];
  const clientEtags = normalizeEtags(
    typeof ifNoneMatchHeader === 'string' || Array.isArray(ifNoneMatchHeader)
      ? ifNoneMatchHeader
      : undefined
  );

  const isNotModified = clientEtags.some(tag => tag === etag || tag === `*`);
  if (isNotModified) {
    if (typeof res.status === 'function') {
      res.status(304);
    } else if (typeof res.statusCode === 'number') {
      res.statusCode = 304;
    }
  } else if (typeof res.statusCode === 'number') {
    res.statusCode = statusCode;
  }

  return {
    etag,
    cacheControl,
    isNotModified,
  };
}
