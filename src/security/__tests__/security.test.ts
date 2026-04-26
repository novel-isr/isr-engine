/**
 * SOC 2 合规辅助代码测试
 *
 * 覆盖：
 *   - audit log 写 NDJSON + 字段固定
 *   - PII 脱敏：email / phone / id-card / JWT / token / 字段名
 *   - redactObject 深度 + 数组 + 循环引用
 */
import { describe, it, expect } from 'vitest';
import { createAuditLogger, redactString, redactObject, addSensitiveKeys } from '../index';

describe('createAuditLogger', () => {
  it('写出 NDJSON 行，字段固定', () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ sink: line => lines.push(line) });
    logger.log({
      action: 'cache_clear',
      actor: 'admin@x.com',
      resource: 'global',
      outcome: 'success',
      requestId: 't-123',
      ip: '1.2.3.4',
      userAgent: 'curl',
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      action: 'cache_clear',
      actor: 'admin@x.com',
      resource: 'global',
      outcome: 'success',
      requestId: 't-123',
      ip: '1.2.3.4',
    });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('outcome=denied / error 都接受', () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ sink: line => lines.push(line) });
    logger.log({ action: 'admin_login', actor: 'x', resource: 'login', outcome: 'denied' });
    logger.log({ action: 'config_change', actor: 'x', resource: 'cfg', outcome: 'error' });
    expect(lines.map(l => JSON.parse(l).outcome)).toEqual(['denied', 'error']);
  });

  it('extra 字段透传', () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ sink: line => lines.push(line) });
    logger.log({
      action: 'x',
      actor: 'a',
      resource: 'r',
      outcome: 'success',
      extra: { ttl: 60, tag: 'books' },
    });
    expect(JSON.parse(lines[0]).extra).toEqual({ ttl: 60, tag: 'books' });
  });
});

describe('redactString', () => {
  it('email 脱敏', () => {
    expect(redactString('contact: john.doe@example.com please')).toBe(
      'contact: [REDACTED:email] please'
    );
  });

  it('国际手机号脱敏', () => {
    expect(redactString('call +1 555-123-4567')).toBe('call [REDACTED:phone]');
  });

  it('中国 11 位手机号脱敏', () => {
    expect(redactString('phone 13800138000')).toBe('phone [REDACTED:phone-cn]');
  });

  it('中国身份证 18 位脱敏', () => {
    expect(redactString('id 110101199003078888')).toBe('id [REDACTED:id-cn]');
  });

  it('JWT token 脱敏', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123XYZ-_def';
    expect(redactString(`Bearer ${jwt}`)).toContain('[REDACTED:jwt]');
  });

  it('AWS access key 脱敏', () => {
    expect(redactString('key=AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws-access-key]');
  });

  it('GitHub token 脱敏', () => {
    expect(redactString('ghp_1234567890abcdefghij1234567890abcdef12')).toContain(
      '[REDACTED:github-token]'
    );
  });

  it('多模式同时命中', () => {
    const out = redactString('email a@b.com phone 13800138000');
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:phone-cn]');
  });

  it('无 PII 时原样返回', () => {
    expect(redactString('plain text without secrets')).toBe('plain text without secrets');
  });
});

describe('redactObject', () => {
  it('敏感 key 整 value 替换', () => {
    expect(redactObject({ user: 'x', password: 'p1', token: 'abc' })).toEqual({
      user: 'x',
      password: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('value 走 redactString 模式匹配', () => {
    expect(redactObject({ msg: 'hi a@b.com' })).toEqual({ msg: 'hi [REDACTED:email]' });
  });

  it('深度递归', () => {
    expect(
      redactObject({
        meta: { user: { email: 'x@y.com', authorization: 'Bearer xxx' } },
      })
    ).toEqual({
      meta: { user: { email: '[REDACTED:email]', authorization: '[REDACTED]' } },
    });
  });

  it('数组递归', () => {
    expect(redactObject(['a@b.com', { secret: 's' }])).toEqual([
      '[REDACTED:email]',
      { secret: '[REDACTED]' },
    ]);
  });

  it('循环引用安全', () => {
    const a: Record<string, unknown> = { name: 'a@b.com' };
    a.self = a;
    expect(() => redactObject(a)).not.toThrow();
  });

  it('null / undefined / number 原样', () => {
    expect(redactObject(null)).toBe(null);
    expect(redactObject(undefined)).toBe(undefined);
    expect(redactObject(42)).toBe(42);
  });

  it('addSensitiveKeys 增加自定义', () => {
    addSensitiveKeys('my_custom_secret');
    expect(redactObject({ my_custom_secret: 'x' })).toEqual({ my_custom_secret: '[REDACTED]' });
  });
});

describe('audit log 集成: 用 redactObject 清 extra', () => {
  it('admin 登录记录脱敏', () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ sink: line => lines.push(line) });
    logger.log({
      action: 'admin_login',
      actor: 'admin',
      resource: 'login',
      outcome: 'success',
      extra: redactObject({
        ip: '1.2.3.4',
        email: 'admin@example.com',
        token: 'eyJ...secret',
      }),
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.extra.email).toBe('[REDACTED:email]');
    expect(parsed.extra.token).toBe('[REDACTED]');
    expect(parsed.extra.ip).toBe('1.2.3.4'); // IP 不算敏感
  });
});
