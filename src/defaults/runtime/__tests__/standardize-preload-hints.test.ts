/**
 * standardize-preload-hints (server-side) 单测
 *
 * 覆盖两条规则：
 *   1. `<link rel=preload as=stylesheet|style>` → `<link rel=stylesheet data-precedence>`
 *   2. FLIGHT_DATA 内联 `:HL[..., "stylesheet"]` → `:HL[..., "style"]`
 *
 * 以及跨 chunk 边界 / 触发字面量切断 / pass-through 不破坏其它 link 的回归。
 */
import { describe, expect, it } from 'vitest';

import {
  bytesIncludeAscii,
  rewritePreloadHints,
  standardizePreloadHints,
} from '../standardize-preload-hints';

/** 把一段 HTML 喂进 standardizePreloadHints stream，拿到完整输出字符串。 */
async function pipeChunks(chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const out = standardizePreloadHints(source);
  const reader = out.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe('rewritePreloadHints (string-level)', () => {
  it('rel=preload as=stylesheet → rel=stylesheet + data-precedence', () => {
    const input = '<link rel="preload" as="stylesheet" href="/assets/HomePage.css">';
    const out = rewritePreloadHints(input);
    expect(out).toBe(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/assets/HomePage.css">'
    );
  });

  it('rel=preload as=style 同样升级（HTML 标准 as 值也促血）', () => {
    const input = '<link rel="preload" as="style" href="/assets/page.css">';
    const out = rewritePreloadHints(input);
    expect(out).toBe(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/assets/page.css">'
    );
  });

  it('保留 crossorigin / integrity 等其它属性', () => {
    const input =
      '<link rel="preload" as="stylesheet" href="/a.css" crossorigin="anonymous" integrity="sha384-abc">';
    const out = rewritePreloadHints(input);
    expect(out).toBe(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/a.css" crossorigin="anonymous" integrity="sha384-abc">'
    );
  });

  it('属性顺序 as 在前 rel 在后 也能正确命中', () => {
    const input = '<link as="stylesheet" rel="preload" href="/b.css">';
    const out = rewritePreloadHints(input);
    expect(out).toContain('rel="stylesheet"');
    expect(out).toContain('data-precedence="vite-rsc/importer-resources"');
    expect(out).toContain('href="/b.css"');
    expect(out).not.toContain('rel="preload"');
    expect(out).not.toContain('as="stylesheet"');
  });

  it('as=font / as=image / as=script 等非 CSS preload 原样透传', () => {
    const cases = [
      '<link rel="preload" as="font" href="/f.woff2" type="font/woff2" crossorigin>',
      '<link rel="preload" as="image" href="/hero.jpg">',
      '<link rel="preload" as="script" href="/index.js">',
    ];
    for (const c of cases) expect(rewritePreloadHints(c)).toBe(c);
  });

  it('普通 <link rel="stylesheet"> 不变（避免再次套 data-precedence）', () => {
    const input = '<link rel="stylesheet" href="/already-blocking.css">';
    expect(rewritePreloadHints(input)).toBe(input);
  });

  it('rel=modulepreload (JS chunk) 不变', () => {
    const input = '<link rel="modulepreload" href="/chunk.js">';
    expect(rewritePreloadHints(input)).toBe(input);
  });

  it('FLIGHT_DATA 提示行 :HL[..., "stylesheet"] → "style"', () => {
    const input =
      'self.__FLIGHT_DATA||(self.__FLIGHT_DATA=[]);self.__FLIGHT_DATA.push("1:HL[\\"/a.css\\",\\"stylesheet\\"]\\n")';
    const out = rewritePreloadHints(input);
    expect(out).toContain(':HL[\\"/a.css\\",\\"style\\"]');
    expect(out).not.toContain('\\"stylesheet\\"');
  });

  it('FLIGHT_DATA 多行批量改写', () => {
    const input = '"1:HL[\\"/a.css\\",\\"stylesheet\\"]\\n2:HL[\\"/b.css\\",\\"stylesheet\\"]\\n"';
    const out = rewritePreloadHints(input);
    expect(out).toBe('"1:HL[\\"/a.css\\",\\"style\\"]\\n2:HL[\\"/b.css\\",\\"style\\"]\\n"');
  });
});

describe('standardizePreloadHints (stream)', () => {
  it('单 chunk 包含整段 HTML，正确升级 preload link', async () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="preload" as="stylesheet" href="/assets/HomePage.css">' +
      '</head><body>x</body></html>';
    const out = await pipeChunks([html]);
    expect(out).toContain(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/assets/HomePage.css">'
    );
    expect(out).not.toContain('rel="preload" as="stylesheet"');
  });

  it('<link 跨 chunk 边界切断（"<lin" | "k rel=...>") 仍正确升级', async () => {
    const html = '<head>' + '<lin' + 'k rel="preload" as="stylesheet" href="/x.css">' + '</head>';
    const out = await pipeChunks([
      html.slice(0, html.indexOf('<lin') + 4),
      html.slice(html.indexOf('<lin') + 4),
    ]);
    expect(out).toContain(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/x.css">'
    );
  });

  it('stylesheet 字面量跨 chunk 边界切断 (sty|lesheet) 仍命中', async () => {
    const html = '<link rel="preload" as="stylesheet" href="/y.css">';
    // 在 "sty" 后切断
    const split = html.indexOf('stylesheet') + 3;
    const out = await pipeChunks([html.slice(0, split), html.slice(split)]);
    expect(out).toContain(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/y.css">'
    );
  });

  it('混合 chunk：preload link + 普通 html + 字体 preload 正确处理', async () => {
    const html =
      '<head>' +
      '<link rel="preload" as="font" href="/f.woff2" type="font/woff2" crossorigin>' +
      '<link rel="preload" as="stylesheet" href="/p.css">' +
      '<title>X</title>' +
      '</head>';
    const out = await pipeChunks([html]);
    // 字体不动
    expect(out).toContain('<link rel="preload" as="font" href="/f.woff2"');
    // CSS 升级
    expect(out).toContain(
      '<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/p.css">'
    );
    expect(out).toContain('<title>X</title>');
  });

  it('零拷贝快路径：不含触发字面量的 chunk 原样透传', async () => {
    const big = 'a'.repeat(8192);
    const out = await pipeChunks([big]);
    expect(out).toBe(big);
  });

  it('FLIGHT_DATA 行被改写：stylesheet → style', async () => {
    const input =
      '<script>self.__FLIGHT_DATA||(self.__FLIGHT_DATA=[]);' +
      'self.__FLIGHT_DATA.push("1:HL[\\"/c.css\\",\\"stylesheet\\"]\\n")</script>';
    const out = await pipeChunks([input]);
    expect(out).toContain(':HL[\\"/c.css\\",\\"style\\"]');
    expect(out).not.toContain('\\"stylesheet\\"');
  });
});

describe('bytesIncludeAscii (memmem fast-path helper)', () => {
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
    // "style" 是 "stylesheet" 的前缀但不应误命中
    expect(bytesIncludeAscii(enc('style style style'), enc('stylesheet'))).toBe(false);
    expect(bytesIncludeAscii(enc('stylesheet'.slice(0, -1)), enc('stylesheet'))).toBe(false);
  });

  it('handles non-ASCII multi-byte content without false positives', () => {
    expect(bytesIncludeAscii(enc('中文 stylé sheet 内容'), enc('stylesheet'))).toBe(false);
    expect(bytesIncludeAscii(enc('🎨 stylesheet 🎨'), enc('stylesheet'))).toBe(true);
  });
});
