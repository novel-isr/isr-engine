import { describe, expect, it } from 'vitest';

import { hasRuntimeRedisConnection, resolveRuntimeRedisConfig } from '../resolveRuntimeRedis';

describe('resolveRuntimeRedisConfig', () => {
  it('runtime.redis url 优先于环境变量', () => {
    const resolved = resolveRuntimeRedisConfig(
      { url: 'redis://runtime:6379/0', keyPrefix: 'app:' },
      { REDIS_URL: 'redis://env:6379/0' }
    );

    expect(resolved).toMatchObject({
      url: 'redis://runtime:6379/0',
      keyPrefix: 'app:',
    });
    expect(hasRuntimeRedisConnection(resolved, {})).toBe(true);
  });

  it('runtime 只声明 keyPrefix 时，由 engine 自动读取 REDIS_URL', () => {
    const resolved = resolveRuntimeRedisConfig(
      { keyPrefix: 'novel:' },
      { REDIS_URL: ' redis://env:6379/1 ' }
    );

    expect(resolved).toMatchObject({
      url: 'redis://env:6379/1',
      keyPrefix: 'novel:',
    });
    expect(hasRuntimeRedisConnection({ keyPrefix: 'novel:' }, { REDIS_URL: 'redis://env' })).toBe(
      true
    );
  });

  it('空字符串 env 不会启用 Redis', () => {
    const resolved = resolveRuntimeRedisConfig(undefined, {
      REDIS_URL: '   ',
      REDIS_HOST: '',
    });

    expect(resolved).toBeUndefined();
    expect(hasRuntimeRedisConnection(undefined, { REDIS_URL: '   ' })).toBe(false);
  });

  it('host/port/password 可从 runtime 和 env 合并', () => {
    const resolved = resolveRuntimeRedisConfig(
      { host: 'redis.internal', keyPrefix: 'isr:' },
      { REDIS_PORT: '6380', REDIS_PASSWORD: 'secret' }
    );

    expect(resolved).toEqual({
      host: 'redis.internal',
      port: 6380,
      password: 'secret',
      keyPrefix: 'isr:',
      invalidationChannel: undefined,
      url: undefined,
    });
  });
});
