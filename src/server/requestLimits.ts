import express, { type Request, type RequestHandler } from 'express';
import {
  ipKeyGenerator,
  rateLimit,
  type ClientRateLimitInfo,
  type Store,
} from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestLimitPolicy, RequestLimitsConfig } from '../types/ISRConfig';

export type RequestLimitCategory = keyof RequestLimitsConfig;
type ResolvedPolicy = Required<RequestLimitPolicy>;

/** Per-process admission budgets for engine-owned work, not page-cache hits or application APIs. */
export const DEFAULT_REQUEST_LIMITS: Readonly<Record<RequestLimitCategory, ResolvedPolicy>> = {
  ops: { windowMs: 60_000, maxRequests: 120, globalMaxRequests: 1200, maxClients: 1000 },
  staticHtml: { windowMs: 60_000, maxRequests: 600, globalMaxRequests: 12_000, maxClients: 10_000 },
  seo: { windowMs: 60_000, maxRequests: 120, globalMaxRequests: 1200, maxClients: 1000 },
};

export function resolveRequestLimitPolicy(
  category: RequestLimitCategory,
  input?: RequestLimitPolicy
): ResolvedPolicy {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError(`server.requestLimits.${category} must be a positive admission policy`);
  }
  const defaults = DEFAULT_REQUEST_LIMITS[category];
  const result = { ...defaults };
  for (const field of ['windowMs', 'maxRequests', 'globalMaxRequests', 'maxClients'] as const) {
    const configured = input?.[field];
    const value = configured === undefined ? defaults[field] : configured;
    if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError(
        `server.requestLimits.${category}.${field} must be a positive safe integer`
      );
    }
    result[field] = value;
  }
  if (result.windowMs > 2_147_483_647) {
    throw new RangeError(`server.requestLimits.${category}.windowMs must be at most 2147483647`);
  }
  return result;
}

export function validateRequestLimits(input?: RequestLimitsConfig): void {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('server.requestLimits must be an object');
  }
  for (const category of ['ops', 'staticHtml', 'seo'] as const) {
    resolveRequestLimitPolicy(category, input?.[category]);
  }
}

interface Counter {
  totalHits: number;
  expiresAt: number;
}

/**
 * A timer-free express-rate-limit Store. Live quotas are never evicted to admit a new IP.
 * A full store denies new clients until expiry; reclamation scans are bounded to once/second.
 */
export class BoundedRateLimitStore implements Store {
  readonly localKeys = true;
  private readonly clients = new Map<string, Counter>();
  private nextSweepAt = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxClients: number,
    private readonly maxRequests: number
  ) {}

  get size(): number {
    return this.clients.size;
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const counter = this.clients.get(key);
    if (!counter || counter.expiresAt <= Date.now()) return undefined;
    return { totalHits: counter.totalHits, resetTime: new Date(counter.expiresAt) };
  }

  increment(key: string): ClientRateLimitInfo {
    const now = Date.now();
    if (now >= this.nextSweepAt) {
      for (const [client, counter] of this.clients) {
        if (counter.expiresAt <= now) this.clients.delete(client);
      }
      this.nextSweepAt = now + Math.min(this.windowMs, 1000);
    }
    let counter = this.clients.get(key);
    if (counter && counter.expiresAt <= now) {
      this.clients.delete(key);
      counter = undefined;
    }
    if (!counter) {
      if (this.clients.size >= this.maxClients) {
        // Fixed-length windows keep insertion order in expiry order; retries wait for capacity.
        const firstExpiry = this.clients.values().next().value?.expiresAt ?? this.nextSweepAt;
        return {
          totalHits: this.maxRequests + 1,
          resetTime: new Date(Math.max(firstExpiry, this.nextSweepAt)),
        };
      }
      counter = { totalHits: 0, expiresAt: now + this.windowMs };
      this.clients.set(key, counter);
    }
    counter.totalHits = Math.min(counter.totalHits + 1, this.maxRequests + 1);
    return { totalHits: counter.totalHits, resetTime: new Date(counter.expiresAt) };
  }

  decrement(key: string): void {
    const counter = this.clients.get(key);
    if (counter) counter.totalHits = Math.max(0, counter.totalHits - 1);
  }

  resetKey(key: string): void {
    this.clients.delete(key);
  }

  resetAll(): void {
    this.clients.clear();
    this.nextSweepAt = 0;
  }
}

/** Connect has no req.ip. An unrestricted trust-proxy setting is never an IP identity boundary. */
export function requestClientKey(req: Request): string {
  const trustProxy = req.app?.get('trust proxy');
  const selected =
    trustProxy === true ? req.socket?.remoteAddress : (req.ip ?? req.socket?.remoteAddress);
  if (!selected || !ipaddr.isValid(selected)) return 'unknown-client';
  // process() collapses both textual forms of IPv4-mapped IPv6 into the same IPv4 bucket.
  return ipKeyGenerator(ipaddr.process(selected).toString(), 56);
}

export function createRequestLimiter(
  category: RequestLimitCategory,
  input?: RequestLimitPolicy
): RequestHandler {
  const policy = resolveRequestLimitPolicy(category, input);
  const router = express.Router();
  const common = {
    windowMs: policy.windowMs,
    // Success quota headers must never be captured into shared ISR response entries.
    standardHeaders: false as const,
    legacyHeaders: false,
    requestPropertyName: 'isrRequestLimit',
    handler: (req: Request, res: express.Response) => {
      const info = (req as Request & { isrRequestLimit?: ClientRateLimitInfo }).isrRequestLimit;
      const remaining = (info?.resetTime?.getTime() ?? Date.now() + policy.windowMs) - Date.now();
      res.statusCode = 429;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(remaining / 1000))));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end('{"error":"Too many requests"}');
    },
  };
  // The constant-key guard also bounds aggregate work when clients rotate IPs/subnets.
  router.use(
    rateLimit({
      ...common,
      limit: policy.globalMaxRequests,
      store: new BoundedRateLimitStore(policy.windowMs, 1, policy.globalMaxRequests),
      keyGenerator: () => 'origin',
    })
  );
  router.use(
    rateLimit({
      ...common,
      limit: policy.maxRequests,
      store: new BoundedRateLimitStore(policy.windowMs, policy.maxClients, policy.maxRequests),
      keyGenerator: requestClientKey,
    })
  );
  return router;
}

/** Bridge an admission middleware into async work without treating its ended 429 as next(). */
export function admitRequest(
  limiter: RequestHandler,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('finish', onEnd);
      res.removeListener('close', onEnd);
    };
    const onEnd = () => {
      cleanup();
      resolve(false);
    };
    res.once('finish', onEnd);
    res.once('close', onEnd);
    try {
      limiter(req as Request, res as express.Response, error => {
        cleanup();
        if (error) reject(error);
        else resolve(!res.writableEnded && !res.destroyed);
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
