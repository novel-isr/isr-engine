import { describe, expect, it } from 'vitest';
import {
  isPublicImageAddress,
  requestPinnedImage,
  resolveImageAddress,
} from '../remoteImageSource';

describe('remote image network isolation', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.168.1.2',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('blocks nonpublic address %s', address => {
    expect(isPublicImageAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '2606:4700:4700::1111'])('permits public address %s', address => {
    expect(isPublicImageAddress(address)).toBe(true);
  });
  it('rejects mixed public/private DNS answers before connection', async () => {
    await expect(
      resolveImageAddress('example.com', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
    ).rejects.toThrow('source address not allowed');
  });
});

it.each(['127.0.0.1', '[::1]', '169.254.169.254'])(
  'enforces the public-address boundary even when transport is called directly for %s',
  async host => {
    await expect(
      requestPinnedImage(new URL(`http://${host}/`), new Set([host]), new AbortController().signal)
    ).rejects.toThrow('source address not allowed');
  }
);

it.each(['http://user:password@allowed.test/', 'file://allowed.test/a', 'https://other.test/'])(
  'enforces the configured authority boundary inside transport for %s',
  async source => {
    await expect(
      requestPinnedImage(new URL(source), new Set(['allowed.test']), new AbortController().signal)
    ).rejects.toThrow('source origin not allowed');
  }
);
