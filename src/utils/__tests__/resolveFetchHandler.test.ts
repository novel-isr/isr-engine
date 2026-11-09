import { expect, it } from 'vitest';
import { resolveFetchHandler } from '../resolveFetchHandler';

const request = new Request('https://example.com/');

it('prefers default.fetch and preserves its receiver and synchronous result', async () => {
  const response = new Response('default');
  const owner = {
    response,
    fetch() {
      return this.response;
    },
  };
  const handler = resolveFetchHandler({ default: owner, fetch: () => new Response('named') });
  expect(handler.fetch(request)).toBe(response);
});

it('binds a named fallback to the module even with an unrelated default object', async () => {
  const mod = {
    default: { marker: 'wrong', fetch: true },
    marker: 'module',
    async fetch() {
      return new Response(this.marker);
    },
  };
  expect(await (await resolveFetchHandler(mod).fetch(request)).text()).toBe('module');
});

it.each([
  undefined,
  null,
  {},
  { default: null },
  { fetch: true },
  { fetch: 'fetch' },
  { default: { fetch: {} } },
])('rejects a module without a callable Fetch export: %j', mod => {
  expect(() => resolveFetchHandler(mod)).toThrow(/dist\/rsc\/index\.js.*fetch/);
});

it('accepts named fetch with null default', async () => {
  const handler = resolveFetchHandler({ default: null, fetch: async () => new Response('named') });
  expect(await (await handler.fetch(request)).text()).toBe('named');
});

it('does not evaluate named fetch when default.fetch is valid', () => {
  const mod = {
    default: { fetch: async () => new Response('default') },
    get fetch() {
      throw new Error('unused');
    },
  };
  expect(() => resolveFetchHandler(mod)).not.toThrow();
});

it('propagates export getter errors during resolution', () => {
  const error = new Error('broken export getter');
  expect(() =>
    resolveFetchHandler({
      get default() {
        throw error;
      },
    })
  ).toThrow(error);
});
