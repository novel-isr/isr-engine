/**
 * standardizePreloadHints —— SSR HTML 与内联 RSC 提示行的 as=stylesheet → as=style 改写。
 *
 * 浏览器只接受 `<link rel=preload as=style>`，react-server-dom-webpack 会发出 `as=stylesheet`，
 * 必须在流出 HTML 前统一矫正。
 */
import { describe, expect, it } from 'vitest';
import { rewritePreloadHints, standardizePreloadHints } from '../runtime/standardize-preload-hints';

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
});
