import { describe, expect, it } from 'vitest';
import { isPublicImageAddress, resolveImageAddress } from '../remoteImageSource';

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

import { createServer } from 'node:http';
import { requestPinnedImage } from '../remoteImageSource';
import { once } from 'node:events';

it('connects a real TCP socket to the supplied address while retaining URL host', async () => {
  const server = createServer((req, res) => {
    res.end(req.headers.host);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const response = await requestPinnedImage(
      new URL(`http://unresolvable.invalid:${port}/a`),
      { address: '127.0.0.1', family: 4 },
      new AbortController().signal
    );
    const remoteAddress = response.socket.remoteAddress;
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(`unresolvable.invalid:${port}`);
    expect(remoteAddress).toBe('127.0.0.1');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

import { createServer as createHttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { readFileSync } from 'node:fs';

it('preserves the URL hostname as TLS SNI and refuses an untrusted certificate', async () => {
  const credentials = {
    key: readFileSync(new URL('./fixtures/image-test-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/image-test-cert.pem', import.meta.url)),
  };
  let servername: string | undefined;
  const server = createHttpsServer({
    ...credentials,
    SNICallback(name, callback) {
      servername = name;
      callback(null, createSecureContext(credentials));
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    await expect(
      requestPinnedImage(
        new URL(`https://image.invalid:${port}/`),
        { address: '127.0.0.1', family: 4 },
        new AbortController().signal
      )
    ).rejects.toThrow(/self-signed/);
    expect(servername).toBe('image.invalid');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('aborts an actual stalled TCP response', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const pending = requestPinnedImage(
      new URL(`http://image.invalid:${port}/`),
      { address: '127.0.0.1', family: 4 },
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
