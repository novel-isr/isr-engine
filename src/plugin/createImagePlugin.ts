/**
 * createImagePlugin —— 图片优化（dev + prod 通用 endpoint）
 *
 * 工业模式（对标 next/image / @vercel/og 的图片处理路径）：
 *   - 端点 `/_/img?src=&w=&q=&fmt=`：sharp 按需 resize/compress/格式转换
 *   - LRU 缓存 transformed buffer + ETag —— 二次命中走 304/缓存
 *   - sharp 是 optionalDependency：用户没装就跳过 endpoint 注册（不报错）
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

let sharpModule: SharpModule | null | undefined; // undefined = not tried; null = unavailable

async function loadSharp(): Promise<SharpModule | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    sharpModule = (await import(/* @vite-ignore */ 'sharp' as string)) as unknown as SharpModule;
    return sharpModule;
  } catch {
    sharpModule = null;
    console.warn('[image-plugin] sharp 未安装，跳过图片优化端点。要启用：pnpm add sharp');
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

export function createImagePlugin(options: ImagePluginOptions = {}): Plugin {
  let publicDir = path.resolve(process.cwd(), 'public');
  const handler = createImageHandler(options, () => publicDir);
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
  options: ImagePluginOptions = {}
): (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void {
  const publicDir = path.resolve(process.cwd(), 'public');
  return createImageHandler(options, () => publicDir);
}

class ImageError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function createImageHandler(opts: ImagePluginOptions, getPublicDir: () => string) {
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
      res.end(error instanceof ImageError ? error.message : 'image processing failed');
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
      const format = SUPPORTED_FORMATS.has(fmt) ? fmt : pickAuto(req.headers.accept);
      const key = JSON.stringify([src, w, q, format]);
      const cached = cache.get(key);
      if (cached) {
        sendImage(req, res, cached);
        return;
      }
      if (active >= 4) throw new ImageError(503, 'image processing busy');
      active++;
      try {
        const sharp = await loadSharp();
        if (!sharp) throw new ImageError(501, 'sharp not installed');
        const input = await loadSource(src, allow, getPublicDir());
        let pipe = sharp.default(input, { limitInputPixels: 40_000_000 });
        if (w) pipe = pipe.resize({ width: w, withoutEnlargement: true });
        const out = await pipe
          .toFormat(format === 'jpg' ? 'jpeg' : format, { quality: q })
          .toBuffer();
        if (out.byteLength > MAX_INPUT_BYTES) throw new ImageError(413, 'output too large');
        const entry = {
          body: out,
          contentType: `image/${format === 'jpg' ? 'jpeg' : format}`,
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

function pickAuto(accept?: string | string[]): string {
  const a = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  if (a.includes('image/avif')) return 'avif';
  if (a.includes('image/webp')) return 'webp';
  return 'jpeg';
}

function sendImage(req: IncomingMessage, res: ServerResponse, entry: CachedImage): void {
  res.setHeader('vary', 'Accept');
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
