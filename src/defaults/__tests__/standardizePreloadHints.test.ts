/**
 * standardizePreloadHints —— SSR HTML 与内联 RSC 提示行的 as=stylesheet → as=style 改写。
 *
 * 浏览器只接受 `<link rel=preload as=style>`，react-server-dom-webpack 会发出 `as=stylesheet`，
 * 必须在流出 HTML 前统一矫正。
 */
import { describe, expect, it } from 'vitest';
import {
  bytesIncludeAscii,
  rewritePreloadHints,
  standardizePreloadHints,
} from '../runtime/standardize-preload-hints';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(input: string | string[]): Promise<string> {
  const chunks = Array.isArray(input) ? input : [input];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const out = standardizePreloadHints(source);
  const reader = out.getReader();
  let result = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe('standardizePreloadHints', () => {
  it('rewrites <link rel=preload as=stylesheet> to as=style', async () => {
    const html = '<link rel="preload" href="/x.css" as="stylesheet"/>';
    expect(await pipe(html)).toBe('<link rel="preload" href="/x.css" as="style"/>');
  });

  it('rewrites HL hint rows inside FLIGHT_DATA pushes', async () => {
    const flight =
      '<script>(self.__FLIGHT_DATA||=[]).push(":HL[\\"/src/styles/global.scss\\",\\"stylesheet\\"]\\n")</script>';
    const out = await pipe(flight);
    expect(out).not.toContain('"stylesheet"');
    expect(out).toContain(':HL[\\"/src/styles/global.scss\\",\\"style\\"]');
  });

  it('rewrites HL hint rows even when split across stream chunks', async () => {
    // 分两块送入，断点正好砸在 `<link` / `:HL[` 中间，验证 carry 逻辑
    const chunks = [
      '<script>(self.__FLIGHT_DATA||=[]).push(":HL[\\"/src/a.scss\\",\\"sty',
      'lesheet\\"]")</script>',
    ];
    const out = await pipe(chunks);
    expect(out).toContain(':HL[\\"/src/a.scss\\",\\"style\\"]');
    expect(out).not.toContain('"stylesheet"');
  });

  it('leaves unrelated stylesheet occurrences alone (e.g. plain rel=stylesheet links)', async () => {
    const html = '<link rel="stylesheet" href="/site.css"/>';
    expect(await pipe(html)).toBe(html);
  });

  it('keeps already-correct as=style untouched', async () => {
    const html = '<link rel="preload" href="/x.css" as="style"/>';
    expect(await pipe(html)).toBe(html);
  });

  it('rewritePreloadHints handles both forms in a single pass', () => {
    const mixed =
      '<link rel="preload" href="/a.css" as="stylesheet"/>' + ':HL[\\"/b.scss\\",\\"stylesheet\\"]';
    const out = rewritePreloadHints(mixed);
    expect(out).toContain('as="style"');
    expect(out).toContain(':HL[\\"/b.scss\\",\\"style\\"]');
    expect(out).not.toContain('"stylesheet"');
  });

  it('passes a chunk with no stylesheet marker through untouched (fast path)', async () => {
    // Big chunk of regular SSR HTML without any rewrite candidate. The byte-level
    // fast path should pass it through verbatim — same length, same content.
    const html =
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/></head><body>'.padEnd(
        4096,
        ' '
      ) + '</body></html>';
    expect(html).not.toContain('stylesheet');
    expect(await pipe(html)).toBe(html);
  });

  it('still rewrites correctly when first chunk is fast-path and second is slow-path', async () => {
    // Realistic SSR pattern: opening HTML lands first (no stylesheet markers),
    // then the inline FLIGHT_DATA push with HL hint rows arrives.
    const chunks = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>x</title></head><body>',
      '<script>(self.__FLIGHT_DATA||=[]).push(":HL[\\"/x.scss\\",\\"stylesheet\\"]")</script>',
    ];
    const out = await pipe(chunks);
    expect(out).toContain(':HL[\\"/x.scss\\",\\"style\\"]');
    expect(out).not.toContain('\\"stylesheet\\"');
  });
});

describe('bytesIncludeAscii', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('returns false when haystack is shorter than needle', () => {
    expect(bytesIncludeAscii(enc('xx'), enc('stylesheet'))).toBe(false);
  });

  it('finds the needle at start, middle, and end', () => {
    expect(bytesIncludeAscii(enc('stylesheet rest'), enc('stylesheet'))).toBe(true);
    expect(bytesIncludeAscii(enc('a b stylesheet c'), enc('stylesheet'))).toBe(true);
    expect(bytesIncludeAscii(enc('a b c stylesheet'), enc('stylesheet'))).toBe(true);
  });

  it('returns false when needle is absent even with similar characters', () => {
    // "style" is a prefix of "stylesheet" — must NOT match
    expect(bytesIncludeAscii(enc('style style style'), enc('stylesheet'))).toBe(false);
    expect(bytesIncludeAscii(enc('stylesheet'.slice(0, -1)), enc('stylesheet'))).toBe(false);
  });

  it('handles non-ASCII multi-byte content without false positives', () => {
    // 中文 / emoji 字节组合不会偶然匹配到 "stylesheet"
    expect(bytesIncludeAscii(enc('中文 stylé sheet 内容'), enc('stylesheet'))).toBe(false);
    expect(bytesIncludeAscii(enc('🎨 stylesheet 🎨'), enc('stylesheet'))).toBe(true);
  });
});
