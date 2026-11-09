import { expect, it } from 'vitest';
import { assertDistinctHtmlRouteIdentities } from '../htmlPathname';

const invalidHtmlRoutes = [
  '/%GG',
  '/%',
  '/%C0%AF',
  'missing-slash',
  '//other.example/a',
  '/a?query',
  '/a#hash',
  '/a\\b',
  '/a//b',
  '/a/%2e%2e/b',
  '/%00',
  '/%0a',
  '/%7f',
  '/a/./b',
  '/raw space',
  '/中文',
  '/a/*',
  '/a/:id',
];

it.each(invalidHtmlRoutes)('rejects invalid declared HTML route %s', route => {
  expect(() => assertDistinctHtmlRouteIdentities([route])).toThrow(/invalid HTML route/i);
});

it('keeps valid escaped values and trailing slash identities', () => {
  expect(() =>
    assertDistinctHtmlRouteIdentities([
      '/',
      '/a',
      '/a/',
      '/books/%E4%B9%A6',
      '/literal/%25',
      '/hash/%23',
      '/question/%3F',
    ])
  ).not.toThrow();
});

it('allows supported route patterns only in the pattern declaration context', () => {
  expect(() =>
    assertDistinctHtmlRouteIdentities(
      ['*', '/books/*', '/books/:id', '/books/%2A', '/books/%3Aid'],
      { allowPatterns: true }
    )
  ).not.toThrow();
});
