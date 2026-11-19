import { expect, it } from 'vitest';
import { isSafeLocalRedirect } from '../safeRedirect';

it.each([
  '/',
  '/books?next=https://external.invalid',
  '/%E4%B9%A6?keep=a%2Fb',
  '/en//external.invalid',
  '/books?literal=\\value',
  '/%2f%2fexternal.invalid',
])('accepts an origin-relative Location without rewriting bytes: %s', target => {
  expect(isSafeLocalRedirect(target)).toBe(true);
});

it.each([
  '//external.invalid',
  '/\\external.invalid',
  'https://external.invalid',
  'javascript:alert(1)',
  ' /safe',
  '/\t/external.invalid',
  '/\n/external.invalid',
  '/safe\r\nLocation: https://external.invalid',
  '/safe\0value',
])('rejects a Location outside the local redirect boundary: %j', target => {
  expect(isSafeLocalRedirect(target)).toBe(false);
});
