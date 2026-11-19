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
  return selectImageOrigin(url, allow) !== undefined;
}

interface ImageOrigin {
  protocol: 'http:' | 'https:';
  hostname: string;
  authority: string;
  port: number;
}

/** Return the configured authority, rather than carrying the request's authority past a guard. */
function selectImageOrigin(url: URL, allow: Set<string>): ImageOrigin | undefined {
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return;
  const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  const defaultPort = protocol === 'https:' ? 443 : 80;
  for (const entry of allow) {
    if (/[\s/@?#*\\]/.test(entry)) continue;
    const authority = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(entry);
    if (!authority) continue;
    let configured: URL;
    try {
      configured = new URL(`${protocol}//${entry}`);
    } catch {
      continue;
    }
    const port = authority[2] === undefined ? defaultPort : Number(authority[2]);
    if (
      !configured.hostname ||
      configured.pathname !== '/' ||
      configured.username ||
      configured.password ||
      url.hostname !== configured.hostname ||
      Number(url.port || defaultPort) !== port
    )
      continue;
    return {
      protocol,
      hostname: configured.hostname.replace(/^\[|\]$/g, ''),
      authority: configured.host,
      port,
    };
  }
}

async function resolveBeforeAbort(hostname: string, signal: AbortSignal): Promise<Address> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      resolveImageAddress(hostname),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** A fresh socket uses a validated public DNS answer and a configured origin at every hop. */
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
      const response = await requestPinnedImage(url, allow, controller.signal);
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

/** No transport entry point accepts a caller-supplied address or unvalidated authority. */
export async function requestPinnedImage(
  url: URL,
  allow: Set<string>,
  signal: AbortSignal,
  accept = 'image/*',
  userAgent?: string
): Promise<import('node:http').IncomingMessage> {
  const origin = selectImageOrigin(url, allow);
  if (!origin) throw new ImageSourceError(400, 'source origin not allowed');
  // Snapshot request components before awaiting DNS; subsequent URL mutation cannot change the target.
  const requestPath = url.pathname + url.search;
  const resolved = await resolveBeforeAbort(origin.hostname, signal);
  const address = { address: resolved.address, family: resolved.family };
  signal.throwIfAborted();
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        path: requestPath,
        agent: false,
        signal,
        maxHeaderSize: 16 * 1024,
        ...(origin.protocol === 'https:'
          ? {
              servername: isIP(origin.hostname) ? undefined : origin.hostname,
              rejectUnauthorized: true,
            }
          : {}),
        // Node may request all answers for autoSelectFamily; return only the pinned answer.
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void
        ) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as import('node:net').LookupFunction,
        headers: {
          host: origin.authority,
          accept,
          'accept-encoding': 'identity',
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
      },
      resolve
    );
    request.once('error', reject);
    request.end();
  });
}
