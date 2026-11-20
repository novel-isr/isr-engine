/** A render lease is acquired before origin work and consumed by an atomic commit. */
export interface CacheRenderLease {
  incarnation: string;
  revision: string;
  /** Durable revisions at the two latest publications, if the backend tracks them. */
  contentRevision?: string;
  previousContentRevision?: string;
  contentPublication?: string;
}

export interface ResponseCacheSnapshot {
  lease: CacheRenderLease;
  value?: unknown;
  version?: string;
}

/** Durable operations never use a process-local fallback. */
export interface ResponseCacheBackend {
  readonly maxTtlMs: number;
  capture(): Promise<CacheRenderLease>;
  read(key: string, cached?: ResponseCacheSnapshot): Promise<ResponseCacheSnapshot>;
  commit(
    key: string,
    value: unknown,
    lease: CacheRenderLease,
    tags: string[],
    ttlMs: number,
    staticSeedUntil?: number
  ): Promise<boolean>;
  seed?(
    key: string,
    value: unknown,
    lease: CacheRenderLease,
    tags: string[],
    ttlMs: number
  ): Promise<boolean>;
  invalidateTag(tag: string): Promise<void>;
  /** Atomically invalidate a publication's response tags and advance its content revision. */
  invalidateTags?(tags: readonly string[], publicationId: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  inspect?(
    limit: number
  ): Promise<Array<{ key: string; sizeBytes: number; ttlSecondsRemaining: number | undefined }>>;
  destroy(): Promise<void>;
}
