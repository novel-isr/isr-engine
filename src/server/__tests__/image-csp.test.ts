import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { createSecurityMiddleware } from '../middleware';

function policy(isDev: boolean): Map<string, string[]> {
  const headers = new Map<string, string>();
  const res = {
    locals: { cspNonce: 'test-nonce' },
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
  };
  createSecurityMiddleware(isDev)({} as Request, res as unknown as Response, () => {});
  return new Map(
    headers
      .get('content-security-policy')!
      .split(';')
      .map(directive => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name, sources];
      })
  );
}

describe('image Content Security Policy', () => {
  it.each([true, false])('permits local, data, blob and HTTPS images (dev=%s)', isDev => {
    expect(policy(isDev).get('img-src')).toEqual(
      isDev
        ? ["'self'", 'data:', 'blob:', 'https:', 'http:']
        : ["'self'", 'data:', 'blob:', 'https:']
    );
  });

  it('preserves development script permissions and production nonce enforcement', () => {
    expect(policy(true).get('script-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      'https:',
      'http:',
      'ws:',
      'wss:',
    ]);
    expect(policy(false).get('script-src')).toEqual([
      "'self'",
      "'nonce-test-nonce'",
      "'strict-dynamic'",
      "'unsafe-inline'",
    ]);
    for (const isDev of [true, false]) {
      expect(policy(isDev).get('object-src')).toEqual(["'none'"]);
      expect(policy(isDev).get('default-src')).toEqual(["'self'"]);
    }
  });
});
