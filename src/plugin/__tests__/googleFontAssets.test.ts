import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { brotliCompressSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import type { FontPluginOptions } from '../createFontPlugin';

const network = vi.hoisted(() => ({
  responses: new Map<
    string,
    { body?: Buffer[]; status?: number; headers?: Record<string, string>; stalled?: boolean }
  >(),
  requests: [] as string[],
}));

vi.mock('../remoteImageSource', () => ({
  requestPinnedImage: async (url: URL, _allow: Set<string>, signal: AbortSignal) => {
    network.requests.push(url.href);
    const fixture = network.responses.get(url.href);
    if (!fixture) throw new Error('unexpected network destination');
    if (fixture.stalled)
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    return Object.assign(Readable.from(fixture.body ?? []), {
      statusCode: fixture.status ?? 200,
      headers: fixture.headers ?? {},
      complete: true,
    });
  },
}));

import { createFontPlugin } from '../createFontPlugin';
import { renderGoogleFontCss, validateWoff2 } from '../googleFontAssets';

const stylesheetUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';
const fontUrl = 'https://fonts.gstatic.com/s/inter/v1/font.woff2';
const css = (source = fontUrl, extra = '') => `/* latin */ @font-face {
  font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap;
  src: url(${source}) format('woff2'); unicode-range: U+0000-00FF;
  ${extra}
}`;

// A small complete WOFF2 container, not a fixture for glyph rendering.
function container(): Buffer {
  const tags = [0, 1, 2, 3, 4, 5, 6, 7];
  const directory = Buffer.from(tags.flatMap(tag => [tag, 4]));
  const compressed = brotliCompressSync(Buffer.alloc(tags.length * 4));
  const header = Buffer.alloc(48);
  header.write('wOF2');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + directory.length + compressed.length, 8);
  header.writeUInt16BE(tags.length, 12);
  header.writeUInt32BE(12 + tags.length * 16 + tags.length * 4, 16);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, directory, compressed]);
}

interface Hooks {
  configResolved(config: unknown): void;
  buildStart(this: unknown): Promise<void>;
  configureServer(server: unknown): void;
  transformIndexHtml(
    html: string,
    context?: { path: string; server?: unknown }
  ): string | Promise<string>;
  closeBundle(this: unknown): void;
  closeWatcher(this: unknown): void;
}

function harness(options: FontPluginOptions = {}, command = 'build', base = '/', reused?: Hooks) {
  const plugin =
    reused ?? (createFontPlugin({ google: ['Inter'], ...options }) as unknown as Hooks);
  const config = { command, base };
  plugin.configResolved(config);
  const emitted: { type: string; fileName: string; source: Buffer }[] = [];
  const context = {
    environment: {
      name: 'client',
      config: { consumer: 'client' },
      getTopLevelConfig: () => config,
    },
    emitFile(asset: { type: string; fileName: string; source: Buffer }) {
      emitted.push(asset);
      return asset.fileName;
    },
  };
  return { plugin, emitted, start: () => plugin.buildStart.call(context), context, config };
}

function memoryServer(plugin: Hooks, config: unknown) {
  const httpServer = new EventEmitter();
  let middleware: (req: unknown, res: unknown, next: () => void) => void = (_req, _res, next) =>
    next();
  const server = {
    config,
    httpServer,
    middlewares: {
      use(fn: typeof middleware) {
        middleware = fn;
      },
    },
  };
  plugin.configureServer(server);
  return {
    server,
    close: () => httpServer.emit('close'),
    read(url: string) {
      let body: unknown;
      const next = vi.fn();
      middleware(
        { url, method: 'GET' },
        {
          setHeader() {},
          end(value: unknown) {
            body = value;
          },
        },
        next
      );
      return { body, next };
    },
  };
}

function serveStylesheet(content = css()) {
  network.responses.set(stylesheetUrl, { body: [Buffer.from(content)] });
  network.responses.set(fontUrl, { body: [container()] });
}

afterEach(() => {
  network.responses.clear();
  network.requests.length = 0;
  vi.useRealTimers();
});

describe('Google font asset boundaries', () => {
  it('shares downloads across concurrent client builds and emits once per build with hash-only filenames', async () => {
    serveStylesheet();
    const h = harness();
    await Promise.all([h.start(), h.start()]);
    expect(network.requests).toEqual([stylesheetUrl, fontUrl]);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].fileName).toMatch(/^_\/fonts\/[a-f0-9]{64}\.woff2$/);
    expect(h.emitted[0].source).toEqual(container());
    const html = await h.plugin.transformIndexHtml('<head></head>');
    expect(html).toContain(`url("/${h.emitted[0].fileName}") format("woff2")`);
    expect(html).toContain('unicode-range: U+0000-00FF');
    expect(html).not.toContain('fonts.gstatic.com');
    await h.start();
    expect(h.emitted).toHaveLength(2);
    expect(network.requests).toHaveLength(2);
  });

  it('leaves server environments to the client asset build', async () => {
    serveStylesheet();
    const h = harness();
    await h.plugin.buildStart.call({
      ...h.context,
      environment: { config: { consumer: 'server' } },
    });
    expect(network.requests).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  it.each([
    'https://evil.test/font.woff2',
    'http://fonts.gstatic.com/font.woff2',
    'https://fonts.gstatic.com:8443/font.woff2',
    'https://user@fonts.gstatic.com/font.woff2',
  ])('rejects the downloaded CSS destination %s before a font request', async source => {
    serveStylesheet(css(source));
    const h = harness();
    await expect(h.start()).rejects.toThrow(/font/);
    expect(network.requests).toEqual([stylesheetUrl]);
    expect(h.emitted).toHaveLength(0);
  });

  it('validates every redirect before connecting and bounds redirect chains', async () => {
    serveStylesheet();
    network.responses.set(fontUrl, {
      status: 302,
      headers: { location: 'https://evil.test/font' },
    });
    const h = harness();
    await expect(h.start()).rejects.toThrow(/font/);
    expect(network.requests).toEqual([stylesheetUrl, fontUrl]);
    expect(h.emitted).toHaveLength(0);
    network.responses.set(fontUrl, { status: 302, headers: { location: fontUrl } });
    await expect(harness().start()).rejects.toThrow(/redirect/);
    expect(network.requests.filter(url => url === fontUrl)).toHaveLength(7);
  });

  it.each([
    css(fontUrl, 'background: url(https://evil.test/a);'),
    `${css()} body { color: red; }`,
    `${css()} </style><script>alert(1)</script>`,
    css().replace("'Inter'", "'Inter</style><script>'"),
  ])('rejects CSS outside the supported font-face grammar', async content => {
    serveStylesheet(content);
    const h = harness();
    await expect(h.start()).rejects.toThrow(/font/);
    expect(h.emitted).toHaveLength(0);
    await expect(h.plugin.transformIndexHtml('<head></head>')).rejects.toThrow(/font/);
  });

  it('escapes raw-text style closures, CSS quotes and C1 controls in every generated CSS string', () => {
    const unsafe = '</style>"\\\u0085';
    const output = renderGoogleFontCss(
      {
        assets: new Map(),
        faces: [{ family: unsafe, style: 'normal', weight: '400', fileName: 'font.woff2' }],
      },
      () => unsafe
    );
    expect(output).not.toMatch(/[<>\u0085]/);
    expect(output).toContain('\\3c /style\\3e \\22 \\5c \\85 ');
  });

  it('never derives asset extensions from remote URLs', async () => {
    const scriptUrl = 'https://fonts.gstatic.com/s/inter/font.js';
    serveStylesheet(css(scriptUrl));
    network.responses.set(scriptUrl, { body: [container()] });
    const h = harness();
    await h.start();
    expect(h.emitted[0].fileName).toMatch(/\.woff2$/);
    expect(h.emitted[0].fileName).not.toContain('.js');
  });

  it('preserves independent unicode subsets and weights without preloading all Google font files', async () => {
    const secondUrl = 'https://fonts.gstatic.com/s/inter/v1/second.woff2';
    serveStylesheet(
      css() +
        css(secondUrl)
          .replace('font-weight: 400', 'font-weight: 700')
          .replace('U+0000-00FF', 'U+4E00-9FFF')
    );
    network.responses.set(secondUrl, { body: [container()] });
    const h = harness();
    await h.start();
    const html = await h.plugin.transformIndexHtml('<head></head>');
    expect(html).toContain('font-weight: 400');
    expect(html).toContain('font-weight: 700');
    expect(html).toContain('U+4E00-9FFF');
    expect(html).not.toContain('rel="preload"');
    expect(h.emitted).toHaveLength(1);
  });

  it('rejects family and face counts beyond the global budget before issuing font requests', async () => {
    await expect(
      harness({ google: Array.from({ length: 33 }, (_value, index) => `Family ${index}`) }).start()
    ).rejects.toThrow(/family/);
    expect(network.requests).toHaveLength(0);
    serveStylesheet(css().repeat(513));
    const h = harness();
    await expect(h.start()).rejects.toThrow(/font/);
    expect(network.requests).toEqual([stylesheetUrl]);
    expect(h.emitted).toHaveLength(0);
  });

  it.each(['../outside', '/absolute', 'fonts/../outside', 'fonts\\outside', 'fonts/%2e%2e'])(
    'rejects output traversal %s before downloading',
    async outDir => {
      expect(() => harness({ outDir })).toThrow(/outDir/);
      expect(network.requests).toHaveLength(0);
    }
  );

  it('bounds streamed CSS bytes without relying on Content-Length', async () => {
    network.responses.set(stylesheetUrl, {
      body: [Buffer.alloc(2 * 1024 * 1024 + 1)],
      headers: { 'content-length': '1' },
    });
    const h = harness();
    await expect(h.start()).rejects.toThrow(/too large/);
    expect(h.emitted).toHaveLength(0);
  });

  it('bounds streamed font bytes and rejects arbitrary HTML content', async () => {
    serveStylesheet();
    network.responses.set(fontUrl, { body: [Buffer.alloc(16 * 1024 * 1024 + 1)] });
    await expect(harness().start()).rejects.toThrow(/too large/);
    network.responses.set(fontUrl, { body: [Buffer.from('<script>alert(1)</script>')] });
    const h = harness();
    await expect(h.start()).rejects.toThrow(/WOFF2/);
    expect(h.emitted).toHaveLength(0);
  });

  it('times out stalled requests and releases the download on dev shutdown', async () => {
    vi.useFakeTimers();
    network.responses.set(stylesheetUrl, { stalled: true });
    const h = harness();
    const pending = expect(h.start()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    const dev = harness({}, 'serve');
    const shutdown = new EventEmitter();
    dev.plugin.configureServer({ httpServer: shutdown, middlewares: { use() {} } });
    const cancelled = expect(dev.start()).rejects.toThrow(/closed/);
    shutdown.emit('close');
    await cancelled;
  });

  it('keeps a reused plugin generation alive when the previous dev server closes after its replacement starts', async () => {
    network.responses.set(stylesheetUrl, { stalled: true });
    const old = harness({}, 'serve', '/old/');
    const oldServer = memoryServer(old.plugin, old.config);
    const cancelledStart = expect(old.start()).rejects.toThrow(/closed/);
    const cancelledHtml = expect(
      old.plugin.transformIndexHtml('<head></head>', {
        path: '/index.html',
        server: oldServer.server,
      })
    ).rejects.toThrow(/closed/);

    serveStylesheet();
    const replacement = harness({}, 'serve', '/new/', old.plugin);
    const replacementServer = memoryServer(replacement.plugin, replacement.config);
    await replacement.start();
    oldServer.close();
    old.plugin.closeBundle.call(old.context);
    await Promise.all([cancelledStart, cancelledHtml]);

    const html = await replacement.plugin.transformIndexHtml('<head></head>', {
      path: '/index.html',
      server: replacementServer.server,
    });
    const asset = /url\("([^"]+)"\)/.exec(html)![1];
    expect(asset).toMatch(/^\/new\//);
    expect(replacementServer.read(asset).body).toEqual(container());
    expect(replacementServer.read(asset).next).not.toHaveBeenCalled();
    expect(oldServer.read(asset).next).toHaveBeenCalledOnce();
    await replacement.start();
    expect(network.requests).toEqual([stylesheetUrl, stylesheetUrl, fontUrl]);
    replacementServer.close();
    expect(replacementServer.read(asset).next).toHaveBeenCalledOnce();
  });

  it('keeps build watch rebuilds active and closes only the owning configuration generation', async () => {
    serveStylesheet();
    const old = harness();
    await old.start();
    old.plugin.closeBundle.call(old.context);
    await old.start();
    expect(old.emitted).toHaveLength(2);
    expect(network.requests).toEqual([stylesheetUrl, fontUrl]);

    const replacement = harness({}, 'build', '/new/', old.plugin);
    await replacement.start();
    old.plugin.closeWatcher.call(old.context);
    await replacement.start();
    expect(replacement.emitted).toHaveLength(2);
    expect(network.requests).toEqual([stylesheetUrl, fontUrl, stylesheetUrl, fontUrl]);
    await expect(old.start()).rejects.toThrow(/closed/);
    replacement.plugin.closeWatcher.call(replacement.context);
    await expect(replacement.start()).rejects.toThrow(/closed/);
  });

  it.each(['/app/', 'https://cdn.test/app/'])('uses the configured Vite base %s', async base => {
    serveStylesheet();
    const h = harness({}, 'build', base);
    await h.start();
    expect(await h.plugin.transformIndexHtml('<head></head>')).toContain(
      `url("${base}${h.emitted[0].fileName}")`
    );
  });

  it('resolves a relative Vite base from a nested HTML entry', async () => {
    serveStylesheet();
    const h = harness({}, 'build', './');
    await h.start();
    expect(
      await h.plugin.transformIndexHtml('<head></head>', { path: '/blog/index.html' })
    ).toContain(`url("../${h.emitted[0].fileName}")`);
  });

  it('serves only validated exact in-memory dev assets with font headers and HEAD semantics', async () => {
    serveStylesheet();
    const h = harness({}, 'serve', '/app/');
    let middleware: (req: unknown, res: unknown, next: () => void) => void = () => {};
    h.plugin.configureServer({
      httpServer: new EventEmitter(),
      middlewares: {
        use(fn: typeof middleware) {
          middleware = fn;
        },
      },
    });
    await h.start();
    expect(h.emitted).toHaveLength(0);
    const html = await h.plugin.transformIndexHtml('<head></head>');
    const asset = /url\("([^"]+)"\)/.exec(html)![1];
    const headers = new Map();
    let body: unknown;
    const next = vi.fn();
    const res = {
      setHeader: (key: string, value: unknown) => headers.set(key, value),
      end: (value: unknown) => {
        body = value;
      },
    };
    middleware({ url: asset, method: 'GET' }, res, next);
    expect(body).toEqual(container());
    expect(headers.get('content-type')).toBe('font/woff2');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(next).not.toHaveBeenCalled();
    middleware({ url: asset, method: 'HEAD' }, res, next);
    expect(body).toBeUndefined();
    middleware({ url: '/app/_/fonts/../private', method: 'GET' }, res, next);
    expect(next).toHaveBeenCalledOnce();
    h.plugin.closeBundle();
    middleware({ url: asset, method: 'GET' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('WOFF2 container validation', () => {
  it('accepts the supported bounded container structure', async () => {
    await expect(validateWoff2(container())).resolves.toBeUndefined();
  });
  it.each([
    (font: Buffer) => {
      font[0] |= 0x80;
    },
    (font: Buffer) => font.writeUInt32BE(0x7fffffff, 16),
    (font: Buffer) => font.writeUInt32BE(font.length + 1, 8),
    (font: Buffer) => font.writeUInt32BE(font.length, 20),
    (font: Buffer) => font.writeUInt32BE(48, 28),
    (font: Buffer) => font.writeUInt16BE(0xffff, 12),
    (font: Buffer) => {
      font[48] = 0xff;
    },
  ])('rejects malformed headers, tables and decompression bounds', async mutate => {
    const font = container();
    mutate(font);
    await expect(validateWoff2(font)).rejects.toThrow(/WOFF2/);
  });
  it('rejects trailing bytes, truncated Brotli data and mismatched table data', async () => {
    const appended = Buffer.concat([container(), Buffer.from('evil')]);
    appended.writeUInt32BE(appended.length, 8);
    await expect(validateWoff2(appended)).rejects.toThrow(/WOFF2/);
    const original = container();
    const truncated = Buffer.from(original.subarray(0, original.length - 1));
    truncated.writeUInt32BE(truncated.length, 8);
    truncated.writeUInt32BE(original.readUInt32BE(20) - 1, 20);
    await expect(validateWoff2(truncated)).rejects.toThrow(/WOFF2/);
    const changed = container();
    changed[49] = 5;
    await expect(validateWoff2(changed)).rejects.toThrow(/WOFF2/);
  });
});
