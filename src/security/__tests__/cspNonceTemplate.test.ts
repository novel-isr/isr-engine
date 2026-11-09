import { expect, it } from 'vitest';
import {
  compileCspNonceTemplate,
  instantiateCspNonceTemplate,
  type CspNonceTemplate,
} from '../cspNonceTemplate';
import { createCspNonceMiddleware } from '../../server/middleware';
import type { Request, Response } from 'express';

const source = '0123456789abcdef0123456789abcdef';
const policy = `default-src 'self';script-src 'self' 'nonce-${source}';style-src 'nonce-${source}'`;

it('compiles byte offsets and replaces quoted attributes plus serialized JS references without mutating shared UTF8 HTML', () => {
  const html = `中文🚀<script nonce="${source}">window.nonce="${source}"</script><script nonce='${source}'>window.options={nonce:'${source}'}</script>`;
  const body = Buffer.from(html);
  const template = compileCspNonceTemplate(policy, body)!;
  expect(template.nonce).toBe(source);
  expect(template.offsets).toHaveLength(4);
  expect(template.offsets[0]).toBe(Buffer.byteLength('中文🚀<script nonce="'));
  const stored = JSON.parse(JSON.stringify(template)) as CspNonceTemplate;
  const replayed = instantiateCspNonceTemplate(body, stored, 'fresh-different-length');
  expect(replayed.toString()).toBe(html.split(source).join('fresh-different-length'));
  expect(body.toString()).toBe(html);
  expect(replayed).not.toBe(body);
});

it.each(['x', 'a'.repeat(64), source])('renders a fresh nonce of any legal length: %s', fresh => {
  const body = Buffer.from(`${source}|${source}${source}`);
  const template = compileCspNonceTemplate(policy, body)!;
  expect(instantiateCspNonceTemplate(body, template, fresh).toString()).toBe(
    `${fresh}|${fresh}${fresh}`
  );
});

it('returns undefined for policies or bodies without a nonce to substitute', () => {
  expect(compileCspNonceTemplate("script-src 'self'", Buffer.from(source))).toBeUndefined();
  expect(
    compileCspNonceTemplate(policy, Buffer.from('<html>no inline scripts</html>'))
  ).toBeUndefined();
});

it('accepts CSP nonce token grammar and duplicate declarations while rejecting ambiguous source nonces', () => {
  const nonce = 'aB0123+/_-==';
  expect(
    compileCspNonceTemplate(
      `script-src 'nonce-${nonce}';style-src 'nonce-${nonce}'`,
      Buffer.from(nonce)
    )
  ).toEqual({ nonce, offsets: [0] });
  expect(() =>
    compileCspNonceTemplate("script-src 'nonce-one' 'nonce-two'", Buffer.from('one two'))
  ).toThrow();
});

it.each(
  [[-1], [0.5], [NaN], [1], [9999], [0, 0], [source.length, 0], []].map(offsets => ({ offsets }))
)('rejects corrupt offset metadata $offsets', ({ offsets }) => {
  expect(() =>
    instantiateCspNonceTemplate(Buffer.from(source + source), { nonce: source, offsets }, 'fresh')
  ).toThrow();
});

it('rejects source bytes that no longer match the compiled template', () => {
  const template = compileCspNonceTemplate(policy, Buffer.from(source))!;
  expect(() =>
    instantiateCspNonceTemplate(Buffer.from('x'.repeat(source.length)), template, 'fresh')
  ).toThrow();
});

it.each(["bad'nonce", 'bad nonce', '<script>', '', '世界', 'trailing\n', 'trailing\u2028'])(
  'rejects unsafe replacement and corrupt source token %s',
  nonce => {
    expect(() =>
      instantiateCspNonceTemplate(Buffer.from(source), { nonce: source, offsets: [0] }, nonce)
    ).toThrow();
    expect(() =>
      instantiateCspNonceTemplate(Buffer.from(source), { nonce, offsets: [0] }, 'fresh')
    ).toThrow();
  }
);

it('generates a 128-bit hex nonce usable verbatim in both HTML and JavaScript strings', () => {
  const req = { headers: {} } as Request;
  const res = { locals: {} } as Response;
  createCspNonceMiddleware()(req, res, () => {});
  expect(res.locals.cspNonce).toMatch(/^[a-f0-9]{32}$/);
  expect(req.headers['x-csp-nonce']).toBe(res.locals.cspNonce);
});
