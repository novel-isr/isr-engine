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
  default: (input: Buffer | string) => SharpInstance;
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
  const endpoint = options.path ?? '/_/img';
  const allow = new Set(options.remoteAllowlist ?? []);
  const cache = new LRUCache<string, CachedImage>({ max: options.cacheMax ?? 500 });
  const defaultQ = Math.max(1, Math.min(100, options.defaultQuality ?? 75));
  const maxW = options.maxWidth ?? 4096;
  let publicDir = '';

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): Promise<void> => {
    const url = req.url ?? '';
    if (!url.startsWith(endpoint)) return next();

    const sharp = await loadSharp();
    if (!sharp) {
      res.statusCode = 501;
      res.setHeader('content-type', 'text/plain');
      res.end('sharp not installed');
      return;
    }

    const u = new URL(url, 'http://x');
    const src = u.searchParams.get('src');
    if (!src) {
      res.statusCode = 400;
      res.end('missing ?src=');
      return;
    }
    const w = clamp(parseInt(u.searchParams.get('w') ?? '0', 10), 1, maxW) || undefined;
    const q = clamp(parseInt(u.searchParams.get('q') ?? String(defaultQ), 10), 1, 100);
    const fmt = (u.searchParams.get('fmt') ?? '').toLowerCase();
    const fmtSafe = SUPPORTED_FORMATS.has(fmt) ? fmt : pickAuto(req.headers['accept']);

    const cacheKey = `${src}|w=${w ?? 'orig'}|q=${q}|fmt=${fmtSafe}`;

    const cached = cache.get(cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) {
      res.statusCode = 304;
      res.setHeader('etag', cached.etag);
      res.end();
      return;
    }
    if (cached) {
      sendImage(res, cached);
      return;
    }

    let input: Buffer | null = null;
    try {
      input = await loadSource(src, allow, publicDir);
    } catch (err) {
      res.statusCode = 400;
      res.end(`source load failed: ${(err as Error).message}`);
      return;
    }
    if (!input || input.byteLength > MAX_INPUT_BYTES) {
      res.statusCode = 413;
      res.end('source too large');
      return;
    }

    try {
      let pipe = sharp.default(input);
      if (w) pipe = pipe.resize({ width: w, withoutEnlargement: true });
      pipe = pipe.toFormat(fmtSafe === 'jpg' ? 'jpeg' : fmtSafe, { quality: q });
      const out = await pipe.toBuffer();
      const ct = `image/${fmtSafe === 'jpg' ? 'jpeg' : fmtSafe}`;
      const etag = `"${createHash('sha1').update(out).digest('hex').slice(0, 16)}"`;
      const entry: CachedImage = { body: out, contentType: ct, etag };
      cache.set(cacheKey, entry);
      sendImage(res, entry);
    } catch (err) {
      res.statusCode = 500;
      res.end(`transform failed: ${(err as Error).message}`);
    }
  };

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

/** 暴露 connect-style 中间件给生产 server.use() —— 路径不匹配时调 next() 放行 */
export function createImageMiddleware(
  options: ImagePluginOptions = {}
): (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void {
  const publicDir = path.resolve(process.cwd(), 'public');
  return createImageHandler({ ...options, publicDir });
}

function createImageHandler(
  opts: ImagePluginOptions & { publicDir: string }
): (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void {
  const endpoint = opts.path ?? '/_/img';
  const allow = new Set(opts.remoteAllowlist ?? []);
  const cache = new LRUCache<string, CachedImage>({ max: opts.cacheMax ?? 500 });
  const defaultQ = Math.max(1, Math.min(100, opts.defaultQuality ?? 75));
  const maxW = opts.maxWidth ?? 4096;

  return function imageMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): void {
    const url = req.url ?? '';
    if (!url.startsWith(endpoint)) {
      next();
      return;
    }
    void handle();
    return;

    async function handle(): Promise<void> {
      const sharp = await loadSharp();
      if (!sharp) {
        res.statusCode = 501;
        res.end('sharp not installed');
        return;
      }
      const u = new URL(url, 'http://x');
      const src = u.searchParams.get('src');
      if (!src) {
        res.statusCode = 400;
        res.end('missing ?src=');
        return;
      }
      const w = clamp(parseInt(u.searchParams.get('w') ?? '0', 10), 1, maxW) || undefined;
      const q = clamp(parseInt(u.searchParams.get('q') ?? String(defaultQ), 10), 1, 100);
      const fmt = (u.searchParams.get('fmt') ?? '').toLowerCase();
      const fmtSafe = SUPPORTED_FORMATS.has(fmt) ? fmt : pickAuto(req.headers['accept']);
      const cacheKey = `${src}|w=${w ?? 'orig'}|q=${q}|fmt=${fmtSafe}`;
      const cached = cache.get(cacheKey);
      if (cached && req.headers['if-none-match'] === cached.etag) {
        res.statusCode = 304;
        res.setHeader('etag', cached.etag);
        res.end();
        return;
      }
      if (cached) {
        sendImage(res, cached);
        return;
      }
      const input = await loadSource(src, allow, opts.publicDir);
      if (!input || input.byteLength > MAX_INPUT_BYTES) {
        res.statusCode = 413;
        res.end('source too large');
        return;
      }
      let pipe = sharp.default(input);
      if (w) pipe = pipe.resize({ width: w, withoutEnlargement: true });
      pipe = pipe.toFormat(fmtSafe === 'jpg' ? 'jpeg' : fmtSafe, { quality: q });
      const out = await pipe.toBuffer();
      const ct = `image/${fmtSafe === 'jpg' ? 'jpeg' : fmtSafe}`;
      const etag = `"${createHash('sha1').update(out).digest('hex').slice(0, 16)}"`;
      const entry: CachedImage = { body: out, contentType: ct, etag };
      cache.set(cacheKey, entry);
      sendImage(res, entry);
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

function sendImage(res: ServerResponse, entry: CachedImage): void {
  res.statusCode = 200;
  res.setHeader('content-type', entry.contentType);
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.setHeader('etag', entry.etag);
  res.setHeader('content-length', entry.body.byteLength);
  res.end(entry.body);
}

async function loadSource(
  src: string,
  allow: Set<string>,
  publicDir: string
): Promise<Buffer | null> {
  if (/^https?:\/\//i.test(src)) {
    const u = new URL(src);
    if (!allow.has(u.host)) {
      throw new Error(`origin not in allowlist: ${u.host}`);
    }
    const r = await fetch(src);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  // 相对路径 / 绝对路径：限制到 publicDir 之内（防目录穿越）
  const cleaned = src.startsWith('/') ? src.slice(1) : src;
  const resolved = path.resolve(publicDir, cleaned);
  if (!resolved.startsWith(publicDir)) throw new Error('path traversal blocked');
  try {
    return await fs.readFile(resolved);
  } catch {
    return null;
  }
}
