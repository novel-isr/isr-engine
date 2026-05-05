import { describe, expect, it } from 'vitest';

import { hasRuntimeRedisConnection, resolveRuntimeRedisConfig } from '../resolveRuntimeRedis';

describe('resolveRuntimeRedisConfig', () => {
  it('runtime.redis url 显式启用 Redis', () => {
    const resolved = resolveRuntimeRedisConfig({
      url: 'redis://runtime:6379/0',
      host: undefined,
      port: undefined,
      password: undefined,
      keyPrefix: 'app:',
      invalidationChannel: undefined,
    });

    expect(resolved).toMatchObject({
      url: 'redis://runtime:6379/0',
      keyPrefix: 'app:',
    });
    expect(hasRuntimeRedisConnection(resolved)).toBe(true);
  });

  it('runtime 只声明 keyPrefix 时不暗读环境变量', () => {
    const resolved = resolveRuntimeRedisConfig({
      url: undefined,
      host: undefined,
      port: undefined,
      password: undefined,
      keyPrefix: 'novel:',
      invalidationChannel: undefined,
    });

    expect(resolved).toMatchObject({
      keyPrefix: 'novel:',
    });
    expect(
      hasRuntimeRedisConnection({
        url: undefined,
        host: undefined,
        port: undefined,
        password: undefined,
        keyPrefix: 'novel:',
        invalidationChannel: undefined,
      })
    ).toBe(false);
  });

  it('未配置连接信息不会启用 Redis', () => {
    const resolved = resolveRuntimeRedisConfig(undefined);

    expect(resolved).toBeUndefined();
    expect(hasRuntimeRedisConnection(undefined)).toBe(false);
  });

  it('host/port/password 只从 runtime.redis 读取', () => {
    const resolved = resolveRuntimeRedisConfig({
      url: undefined,
      host: 'redis.internal',
      port: 6380,
      password: 'secret',
      keyPrefix: 'isr:',
      invalidationChannel: undefined,
    });

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
