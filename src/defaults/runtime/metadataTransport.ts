import { trimTrailingSlashes } from '../../utils/trimTrailingSlashes';

export class MetadataHttpError extends Error {
  constructor(readonly status: number) {
    super(`Metadata request failed with HTTP ${status}`);
  }
}

export function resolveMetadataUrl(
  endpoint: string,
  baseUrl: string | undefined | (() => string | null | undefined)
): string | null {
  if (/^(https?:)?\/\//i.test(endpoint)) return endpoint;
  const base = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
  return base ? `${trimTrailingSlashes(base)}/${endpoint.replace(/^\/+/, '')}` : null;
}

export async function requestMetadataJson(
  url: string,
  timeoutMs: number | null = 1200
): Promise<unknown> {
  const response =
    timeoutMs === null
      ? await fetch(url)
      : await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new MetadataHttpError(response.status);
  }
  return response.status === 204 ? null : response.json();
}
