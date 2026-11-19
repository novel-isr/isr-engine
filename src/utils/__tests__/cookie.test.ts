import { describe, expect, it } from 'vitest';

import { getCookieHeader, parseCookieHeader, readCookie } from '../cookie';

describe('cookie utilities', () => {
  it('treats prototype names as ordinary cookie names and never inherits absent cookies', () => {
    expect(readCookie('uid=42', 'constructor')).toBeUndefined();
    expect(readCookie('', 'toString')).toBeUndefined();
    const cookies = parseCookieHeader('__proto__=value; constructor=own');
    expect(cookies.__proto__).toBe('value');
    expect(cookies.constructor).toBe('own');
    expect(Object.getPrototypeOf(cookies)).toBeNull();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('creates own data properties for every cookie name and preserves last-value semantics', () => {
    const cookies = parseCookieHeader(
      '__proto__=polluted; constructor=first; toString=text; valueOf=value; constructor=last'
    );
    for (const [name, value] of [
      ['__proto__', 'polluted'],
      ['constructor', 'last'],
      ['toString', 'text'],
      ['valueOf', 'value'],
    ]) {
      expect(Object.getOwnPropertyDescriptor(cookies, name)).toEqual({
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    expect(readCookie('__proto__=value', '__proto__')).toBe('value');
    expect(Object.keys(parseCookieHeader(''))).toEqual([]);
    expect(Object.getPrototypeOf(parseCookieHeader(''))).toBeNull();
  });
  it('reads cookies from a Web Request', () => {
    const req = new Request('https://example.com', {
      headers: { cookie: 'uid=42; locale=zh-CN; theme=dark' },
    });

    expect(readCookie(req, 'uid')).toBe('42');
    expect(readCookie(req, 'locale')).toBe('zh-CN');
    expect(readCookie(req, 'missing')).toBeUndefined();
  });

  it('reads cookies from Node-style header records', () => {
    expect(
      readCookie(
        {
          headers: {
            cookie: ['a=b', 'uid=user%201'],
          },
        },
        'uid'
      )
    ).toBe('user 1');
  });

  it('preserves equals signs in values', () => {
    expect(parseCookieHeader('token=a=b=c; uid=1')).toEqual({
      token: 'a=b=c',
      uid: '1',
    });
  });

  it('does not throw on malformed percent encoding', () => {
    expect(parseCookieHeader('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' });
  });

  it('returns a normalized cookie header from a string source', () => {
    expect(getCookieHeader('a=1; b=2')).toBe('a=1; b=2');
  });
});
