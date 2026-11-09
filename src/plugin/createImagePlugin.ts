/**
 * createImagePlugin —— 图片优化（dev + prod 通用 endpoint）
 *
 * 工业模式（对标 next/image / @vercel/og 的图片处理路径）：
 *   - 端点 `/_/img?src=&w=&q=&fmt=`：sharp 按需 resize/compress/格式转换
 *   - LRU 缓存 transformed buffer + ETag —— 二次命中走 304/缓存
 *   - sharp 是 optionalDependency：缺失时转换返回 501；fmt=original 可显式读取安全栅格原图
 *   - <Image> 组件（src/runtime/Image.tsx）输出 srcset，浏览器选最佳分辨率
 *
 * 安全：
 *   - allowlist origin：默认仅允许 same-origin + 用户配置白名单（防 SSRF）
 *   - max 输出 8192px / 输入 25MB（防 zip-bomb / OOM）
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { LRUCache } from 'lru-cache';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';

export interface ImagePluginOptions {
  /** 端点 path，默认 '/_/img' */
  path?: string;
  /** 允许的远程源域名白名单（防 SSRF），默认 [] —— 仅允许相对路径 / public 资源 */
  remoteAllowlist?: string[];
  /** LRU 容量（条），默认 500 */
  cacheMax?: number;
  /** 默认质量（1-100），默认 75 */
  defaultQuality?: number;
  /** 最大输出宽度，默认 4096 */
  maxWidth?: number;
}

interface SharpModule {
  default: (input: Buffer | string, options?: { limitInputPixels: number }) => SharpInstance;
}
interface SharpInstance {
  resize(opts: { width?: number; height?: number; withoutEnlargement?: boolean }): SharpInstance;
  toFormat(fmt: string, opts?: { quality?: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
}

/** Instance-scoped capability injection, also useful for custom optimizer loading. */
export interface ImageProcessingDependencies {
  loadSharp?: () => Promise<SharpModule | null>;
}

async function loadSharp(): Promise<SharpModule | null> {
  try {
    return (await import(/* @vite-ignore */ 'sharp' as string)) as unknown as SharpModule;
  } catch {
    return null;
  }
}

const SUPPORTED_FORMATS = new Set(['avif', 'webp', 'jpeg', 'jpg', 'png']);
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

interface CachedImage {
  body: Buffer;
  contentType: string;
  etag: string;
}

export function createImagePlugin(
  options: ImagePluginOptions = {},
  dependencies: ImageProcessingDependencies = {}
): Plugin {
  let publicDir = path.resolve(process.cwd(), 'public');
  const handler = createImageHandler(options, () => publicDir, dependencies);
  return {
    name: 'novel-isr:image-optimization',
    configResolved(c) {
      publicDir = c.publicDir || path.resolve(c.root, 'public');
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

/** Connect middleware shared by development, preview and production. */
export function createImageMiddleware(
  options: ImagePluginOptions = {},
  dependencies: ImageProcessingDependencies = {}
): (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void {
  const publicDir = path.resolve(process.cwd(), 'public');
  return createImageHandler(options, () => publicDir, dependencies);
}

class ImageError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function createImageHandler(
  opts: ImagePluginOptions,
  getPublicDir: () => string,
  dependencies: ImageProcessingDependencies
) {
  let sharpCapability: Promise<SharpModule | null> | undefined;
  const endpoint = opts.path ?? '/_/img';
  const allow = new Set(opts.remoteAllowlist ?? []);
  const cache = new LRUCache<string, CachedImage>({
    max: Math.max(1, opts.cacheMax ?? 500),
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: entry => entry.body.byteLength,
    ttl: 60_000,
  });
  const defaultQ = clamp(opts.defaultQuality ?? 75, 1, 100) || 75;
  const maxW = clamp(opts.maxWidth ?? 4096, 1, 8192) || 4096;
  let active = 0;

  return function imageMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): void {
    let u: URL;
    try {
      u = new URL(req.url ?? '', 'http://x');
    } catch {
      next();
      return;
    }
    if (u.pathname !== endpoint) {
      next();
      return;
    }
    void handle(u).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = error instanceof ImageError ? error.status : 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'no-store');
      res.end(
        req.method === 'HEAD'
          ? undefined
          : error instanceof ImageError
            ? error.message
            : 'image processing failed'
      );
    });

    async function handle(url: URL): Promise<void> {
      const src = url.searchParams.get('src');
      if (!src) throw new ImageError(400, 'missing ?src=');
      if (req.method && req.method !== 'GET' && req.method !== 'HEAD')
        throw new ImageError(405, 'method not allowed');
      const wParam = url.searchParams.get('w');
      const w = wParam === null ? undefined : clamp(parseInt(wParam, 10), 1, maxW) || undefined;
      const q =
        clamp(parseInt(url.searchParams.get('q') ?? String(defaultQ), 10), 1, 100) || defaultQ;
      const fmt = (url.searchParams.get('fmt') ?? '').toLowerCase();
      if (fmt && fmt !== 'original' && !SUPPORTED_FORMATS.has(fmt))
        throw new ImageError(400, 'unsupported format');
      if (fmt === 'original' && (wParam !== null || url.searchParams.has('q')))
        throw new ImageError(400, 'original mode does not accept transformations');
      const format = fmt || pickAuto(req.headers.accept);
      const key = JSON.stringify([src, w, q, format]);
      const cached = cache.get(key);
      if (cached) {
        sendImage(req, res, cached);
        return;
      }
      if (active >= 4) throw new ImageError(503, 'image processing busy');
      active++;
      try {
        let out: Buffer;
        let contentType: string;
        if (format === 'original') {
          out = await loadSource(src, allow, getPublicDir());
          contentType = originalContentType(out);
        } else {
          const sharp = await (sharpCapability ??= (dependencies.loadSharp ?? loadSharp)());
          if (!sharp)
            throw new ImageError(
              501,
              'sharp not installed; use fmt=original without transformations'
            );
          const input = await loadSource(src, allow, getPublicDir());
          let pipe = sharp.default(input, { limitInputPixels: 40_000_000 });
          if (w) pipe = pipe.resize({ width: w, withoutEnlargement: true });
          out = await pipe.toFormat(format === 'jpg' ? 'jpeg' : format, { quality: q }).toBuffer();
          contentType = `image/${format === 'jpg' ? 'jpeg' : format}`;
        }
        if (out.byteLength > MAX_INPUT_BYTES) throw new ImageError(413, 'output too large');
        const entry = {
          body: out,
          contentType,
          etag: `"${createHash('sha1').update(out).digest('hex').slice(0, 16)}"`,
        };
        cache.set(key, entry);
        sendImage(req, res, entry);
      } finally {
        active--;
      }
    }
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

/** Media range specificity takes precedence over wildcard quality (RFC 9110). */
function acceptQuality(contentType: string, accept?: string | string[]): number {
  if (accept === undefined) return 1;
  let specificity = -1;
  let quality = 0;
  for (const range of (Array.isArray(accept) ? accept.join(',') : accept).split(',')) {
    const [type, ...parameters] = range.trim().toLowerCase().split(';');
    const rank = type === contentType ? 2 : type === 'image/*' ? 1 : type === '*/*' ? 0 : -1;
    if (rank < 0 || rank < specificity) continue;
    const qParam = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const qText = qParam?.slice(2);
    const q =
      qText === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qText)
          ? Number(qText)
          : 0;
    if (rank > specificity) quality = q;
    else quality = Math.max(quality, q);
    specificity = rank;
  }
  return quality;
}

function pickAuto(accept?: string | string[]): string {
  // JPEG remains the default for absent or equally preferred wildcard ranges.
  const candidates = ['jpeg', 'webp', 'avif'];
  let selected = '';
  let best = 0;
  for (const format of candidates) {
    const quality = acceptQuality(`image/${format}`, accept);
    if (quality > best) {
      selected = format;
      best = quality;
    }
  }
  if (!selected) throw new ImageError(406, 'no acceptable image format');
  return selected;
}

// Check chunk boundaries and the mandatory end marker without decoding compressed pixels.
function completePng(input: Buffer): boolean {
  let offset = 8;
  let hasPixels = false;
  while (offset + 12 <= input.length) {
    const size = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + size;
    if (end > input.length) return false;
    if (type === 'IDAT' && size > 0) hasPixels = true;
    if (type === 'IEND') return size === 0 && end === input.length && hasPixels;
    offset = end;
  }
  return false;
}

/** Only inert raster containers are served directly; never trust extensions or upstream MIME. */
function originalContentType(input: Buffer): string {
  if (
    input.length >= 33 &&
    input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    input.readUInt32BE(8) === 13 &&
    input.toString('ascii', 12, 16) === 'IHDR' &&
    input.readUInt32BE(16) > 0 &&
    input.readUInt32BE(20) > 0 &&
    completePng(input)
  )
    return 'image/png';
  if (
    input.length >= 4 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff &&
    input[input.length - 2] === 0xff &&
    input[input.length - 1] === 0xd9
  )
    return 'image/jpeg';
  if (
    input.length >= 14 &&
    ['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6)) &&
    input.readUInt16LE(6) > 0 &&
    input.readUInt16LE(8) > 0 &&
    input[input.length - 1] === 0x3b
  )
    return 'image/gif';
  if (
    input.length >= 20 &&
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.readUInt32LE(4) === input.length - 8 &&
    input.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(input.toString('ascii', 12, 16))
  )
    return 'image/webp';
  throw new ImageError(415, 'unsupported original image type');
}

function sendImage(req: IncomingMessage, res: ServerResponse, entry: CachedImage): void {
  res.setHeader('vary', 'Accept');
  res.setHeader('x-content-type-options', 'nosniff');
  if (acceptQuality(entry.contentType, req.headers.accept) <= 0)
    throw new ImageError(406, 'image type not acceptable');
  res.setHeader('cache-control', 'public, max-age=60, must-revalidate');
  res.setHeader('etag', entry.etag);
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', entry.contentType);
  res.setHeader('content-length', entry.body.byteLength);
  res.end(req.method === 'HEAD' ? undefined : entry.body);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function loadSource(src: string, allow: Set<string>, publicDir: string): Promise<Buffer> {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) {
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      throw new ImageError(400, 'invalid source URL');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          !allow.has(url.host) ||
          url.username ||
          url.password
        ) {
          throw new ImageError(400, 'source origin not allowed');
        }
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 5) throw new ImageError(400, 'invalid source redirect');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ImageError(400, 'source fetch failed');
        }
        if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES) {
          await response.body.cancel();
          throw new ImageError(413, 'source too large');
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_INPUT_BYTES) throw new ImageError(413, 'source too large');
            chunks.push(Buffer.from(value));
          }
          return Buffer.concat(chunks, size);
        } finally {
          await reader.cancel();
        }
      }
      throw new ImageError(400, 'too many source redirects');
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageError(controller.signal.aborted ? 504 : 400, 'source fetch failed');
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const root = await fs.realpath(publicDir);
    const resolved = path.resolve(root, src.startsWith('/') ? src.slice(1) : src);
    if (!inside(root, resolved)) throw new ImageError(400, 'path traversal blocked');
    const real = await fs.realpath(resolved);
    if (!inside(root, real)) throw new ImageError(400, 'path traversal blocked');
    const file = await fs.open(real, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new ImageError(400, 'invalid source file');
      if (stat.size > MAX_INPUT_BYTES) throw new ImageError(413, 'source too large');
      // Bound the read even if a file grows after stat().
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_INPUT_BYTES + 1));
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_INPUT_BYTES || size > stat.size)
        throw new ImageError(413, 'source changed during read');
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(404, 'source not found');
  }
}
