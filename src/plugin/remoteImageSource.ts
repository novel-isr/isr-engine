import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';

export class ImageSourceError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const resolveAll: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });
export function isPublicImageAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    // IPv4 mapped/transition forms are rejected rather than translated.
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolveImageAddress(
  hostname: string,
  resolve: Resolver = resolveAll
): Promise<Address> {
  const name = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(name) ? [{ address: name, family: isIP(name) }] : await resolve(name);
  if (!addresses.length || addresses.some(a => !isPublicImageAddress(a.address)))
    throw new ImageSourceError(400, 'source address not allowed');
  return addresses[0] as Address;
}

/** Bare hosts permit protocol-default ports; explicit ports remain exact restrictions. */
export function isAllowedImageOrigin(url: URL, allow: Set<string>): boolean {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allow.has(`${url.hostname}:${port}`) || (!url.port && allow.has(url.hostname));
}

/** A fresh socket uses exactly the DNS address validated above; URL hostname remains TLS identity. */
export async function fetchRemoteImage(
  src: string,
  allow: Set<string>,
  maxBytes: number
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let url = new URL(src);
    for (let hop = 0; hop <= 5; hop++) {
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !isAllowedImageOrigin(url, allow) ||
        url.username ||
        url.password
      )
        throw new ImageSourceError(400, 'source origin not allowed');
      const address = await Promise.race([
        resolveImageAddress(url.hostname),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted)
            reject(new ImageSourceError(504, 'source fetch timed out'));
          else
            controller.signal.addEventListener(
              'abort',
              () => reject(new ImageSourceError(504, 'source fetch timed out')),
              { once: true }
            );
        }),
      ]);
      const response = await requestPinnedImage(url, address, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.destroy();
        if (!response.headers.location || hop === 5)
          throw new ImageSourceError(400, 'invalid source redirect');
        url = new URL(response.headers.location, url);
        continue;
      }
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy();
        throw new ImageSourceError(400, 'source fetch failed');
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        throw new ImageSourceError(413, 'source too large');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > maxBytes) throw new ImageSourceError(413, 'source too large');
          chunks.push(Buffer.from(chunk));
        }
        if (!response.complete) throw new ImageSourceError(400, 'incomplete source response');
        return Buffer.concat(chunks, size);
      } finally {
        response.destroy();
      }
    }
    throw new ImageSourceError(400, 'invalid source redirect');
  } catch (error) {
    if (error instanceof ImageSourceError) throw error;
    throw new ImageSourceError(controller.signal.aborted ? 504 : 400, 'source fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Internal transport boundary: the caller must supply an already validated address. */
export function requestPinnedImage(
  url: URL,
  address: Address,
  signal: AbortSignal
): Promise<import('node:http').IncomingMessage> {
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        signal,
        // Node may request all answers for autoSelectFamily; return only the pinned answer.
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void
        ) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as import('node:net').LookupFunction,
        headers: { accept: 'image/*', 'accept-encoding': 'identity' },
      },
      resolve
    );
    request.once('error', reject);
    request.end();
  });
}
