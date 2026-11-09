import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type {
  CacheRenderLease,
  ResponseCacheBackend,
  ResponseCacheSnapshot,
} from './ResponseCacheBackend';

export const MAX_RESPONSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TAGS = 128;

// Every key is explicit and colocated. The current connection factory is standalone;
// the hash tag also makes this protocol safe to execute on one Cluster slot.
const PRELUDE = `
local function kind(key)
  local result = redis.call('TYPE', key)
  if type(result) == 'table' then return result.ok end
  return result
end
local function requireKind(key, expected)
  local actual = kind(key)
  if actual ~= 'none' and actual ~= expected then error('response cache key type mismatch') end
end
requireKind(KEYS[1], 'hash')
requireKind(KEYS[2], 'hash')
requireKind(KEYS[3], 'zset')
if #KEYS == 4 then requireKind(KEYS[4], 'hash') end
local function initialize(newIncarnation)
  redis.call('DEL', KEYS[2], KEYS[3])
  redis.call('HSET', KEYS[1], 'incarnation', newIncarnation, 'revision', '0')
  redis.call('HSET', KEYS[2], '__incarnation', newIncarnation)
  redis.call('ZADD', KEYS[3], '+inf', '__incarnation:' .. newIncarnation)
  redis.call('PEXPIRE', KEYS[2], ${MAX_RESPONSE_TTL_MS})
  redis.call('PEXPIRE', KEYS[3], ${MAX_RESPONSE_TTL_MS})
end
local incarnation = redis.call('HGET', KEYS[1], 'incarnation')
local revision = redis.call('HGET', KEYS[1], 'revision')
if not incarnation then
  if kind(KEYS[1]) ~= 'none' then error('response cache control is corrupt') end
  incarnation = ARGV[1]
  revision = '0'
  initialize(incarnation)
elseif not revision or not string.match(revision, '^%d+$') then
  error('response cache revision is corrupt')
elseif redis.call('HGET', KEYS[2], '__incarnation') ~= incarnation
  or not redis.call('ZSCORE', KEYS[3], '__incarnation:' .. incarnation) then
  -- Eviction and retention expiry are indistinguishable. Both require a new
  -- incarnation: missing tombstones must never make old responses valid again.
  incarnation = ARGV[1]
  revision = '0'
  initialize(incarnation)
end
local function older(a, b)
  if #a ~= #b then return #a < #b end
  return a < b
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

const CAPTURE = PRELUDE + `return {incarnation, revision}`;
const READ =
  PRELUDE +
  `
local entry = redis.call('HMGET', KEYS[4], 'incarnation', 'revision', 'expiresAt', 'tags', 'version')
if not entry[1] then return {incarnation, revision, 'miss'} end
if entry[1] ~= incarnation or tonumber(entry[3]) <= now or redis.call('PTTL', KEYS[4]) <= 0 then
  redis.call('DEL', KEYS[4])
  return {incarnation, revision, 'miss'}
end
for _, tag in ipairs(cjson.decode(entry[4])) do
  local invalidated = redis.call('HGET', KEYS[2], tag)
  if invalidated and older(entry[2], invalidated) then
    redis.call('DEL', KEYS[4])
    return {incarnation, revision, 'miss'}
  end
end
if ARGV[2] == incarnation and ARGV[4] == entry[5] then
  return {incarnation, revision, 'unchanged', entry[5]}
end
return {incarnation, revision, 'value', entry[5], redis.call('HGET', KEYS[4], 'value')}
`;
const COMMIT =
  PRELUDE +
  `
if ARGV[2] ~= incarnation or ARGV[3] ~= revision then return 0 end
local ttl = tonumber(ARGV[4])
if not ttl or ttl < 1 or ttl > ${MAX_RESPONSE_TTL_MS} then error('response cache TTL out of range') end
local tags = cjson.decode(ARGV[5])
if #tags > ${MAX_TAGS + 1} then error('response cache tag budget exceeded') end
redis.call('HSET', KEYS[4], 'incarnation', incarnation, 'revision', revision, 'expiresAt', now+ttl, 'tags', ARGV[5], 'version', ARGV[7], 'value', ARGV[6], 'key', ARGV[8])
redis.call('PEXPIRE', KEYS[4], ttl)
return 1
`;
const INVALIDATE =
  PRELUDE +
  `
redis.call('HINCRBY', KEYS[1], 'revision', 1)
revision = redis.call('HGET', KEYS[1], 'revision')
redis.call('HSET', KEYS[2], ARGV[2], revision)
redis.call('ZADD', KEYS[3], now + ${MAX_RESPONSE_TTL_MS}, ARGV[2])
-- Each response lives at most maxTtl. Older tombstones can be reclaimed;
-- global revision still fences every lease acquired before invalidation.
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 128)
for _, field in ipairs(expired) do
  redis.call('HDEL', KEYS[2], field)
  redis.call('ZREM', KEYS[3], field)
end
redis.call('PEXPIRE', KEYS[2], ${MAX_RESPONSE_TTL_MS})
redis.call('PEXPIRE', KEYS[3], ${MAX_RESPONSE_TTL_MS})
return {incarnation, revision}
`;
const CLEAR =
  PRELUDE +
  `
initialize(ARGV[2])
return 1
`;

/** Atomic response protocol, separate from the generic adapter's fallback policy. */
export class RedisResponseCacheBackend implements ResponseCacheBackend {
  readonly maxTtlMs = MAX_RESPONSE_TTL_MS;
  private readonly keys: string[];
  private readonly prefix: string;
  private destroyed = false;

  constructor(
    private readonly connection: () => Promise<Redis>,
    namespace: string,
    private readonly close?: () => Promise<void>
  ) {
    const digest = createHash('sha256').update(namespace).digest('hex');
    const prefix = `response:v1:{${digest}}:`;
    this.prefix = prefix;
    this.keys = [prefix + 'control', prefix + 'invalidated', prefix + 'expiry'];
  }

  private digest(tag: string): string {
    return createHash('sha256').update(tag).digest('hex');
  }

  private entryKey(key: string): string {
    return this.prefix + 'entry:' + this.digest(key);
  }

  private async execute(script: string, key: string | undefined, args: string[]) {
    if (this.destroyed) throw new Error('response cache backend is closed');
    const client = await this.connection();
    const keys = key === undefined ? this.keys : [...this.keys, this.entryKey(key)];
    return client.eval(script, keys.length, ...keys, randomUUID(), ...args);
  }

  async capture(): Promise<CacheRenderLease> {
    const result = (await this.execute(CAPTURE, undefined, [])) as string[];
    return { incarnation: result[0], revision: result[1] };
  }

  async read(key: string, cached?: ResponseCacheSnapshot): Promise<ResponseCacheSnapshot> {
    const result = (await this.execute(READ, key, [
      cached?.lease.incarnation ?? '',
      cached?.lease.revision ?? '',
      cached?.value !== undefined ? (cached.version ?? '') : '',
    ])) as string[];
    const lease = { incarnation: result[0], revision: result[1] };
    if (result[2] === 'unchanged') return { lease, version: result[3], value: cached?.value };
    return {
      lease,
      version: result[2] === 'value' ? result[3] : undefined,
      value: result[2] === 'value' ? JSON.parse(result[4]) : undefined,
    };
  }

  async commit(
    key: string,
    value: unknown,
    lease: CacheRenderLease,
    tags: string[],
    ttlMs: number
  ): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs)
      throw new RangeError('response cache TTL must be within 1ms and 30 days');
    if (tags.length > MAX_TAGS) throw new RangeError('response cache allows at most 128 tags');
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new TypeError('response cache value must be JSON serializable');
    const fields = [
      ...new Set([...tags.map(tag => this.digest(tag)), this.digest(`entry:${key}`)]),
    ];
    return (
      (await this.execute(COMMIT, key, [
        lease.incarnation,
        lease.revision,
        String(ttlMs),
        JSON.stringify(fields),
        serialized,
        randomUUID(),
        key,
      ])) === 1
    );
  }

  async invalidateTag(tag: string): Promise<void> {
    await this.execute(INVALIDATE, undefined, [this.digest(tag)]);
  }

  async remove(key: string): Promise<void> {
    await this.invalidateTag(`entry:${key}`);
  }

  async clear(): Promise<void> {
    await this.execute(CLEAR, undefined, [randomUUID()]);
  }

  async inspect(limit: number) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 100;
    const lease = await this.capture();
    const client = await this.connection();
    const configuredPrefix = client.options.keyPrefix ?? '';
    const fullPrefix = configuredPrefix + this.prefix + 'entry:';
    const pattern = fullPrefix.replace(/[?*[\]\\]/g, '\\$&') + '*';
    const entries: Array<{
      key: string;
      sizeBytes: number;
      ttlSecondsRemaining: number | undefined;
    }> = [];
    let cursor = '0';
    for (let page = 0; page < 100 && entries.length < cap; page++) {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      for (const fullKey of keys) {
        if (!fullKey.startsWith(fullPrefix) || entries.length >= cap) continue;
        const redisKey = fullKey.slice(configuredPrefix.length);
        const [incarnation, key] = await client.hmget(redisKey, 'incarnation', 'key');
        if (!key || incarnation !== lease.incarnation) continue;
        const [size, ttl] = await Promise.all([
          client.hstrlen(redisKey, 'value'),
          client.pttl(redisKey),
        ]);
        if (ttl > 0)
          entries.push({ key, sizeBytes: size, ttlSecondsRemaining: Math.ceil(ttl / 1000) });
      }
      if (cursor === '0') break;
    }
    return entries;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.close?.();
  }
}
