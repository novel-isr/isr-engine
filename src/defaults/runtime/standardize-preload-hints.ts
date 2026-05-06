/**
 * standardize-preload-hints —— 修正 SSR HTML 与内联 RSC 流里的 `as=stylesheet`。
 *
 * 浏览器只接受 `<link rel=preload as=style>`；react-server-dom-webpack 仍然
 * 用 `as=stylesheet`，会触发 Chrome / Firefox 控制台警告：
 *   `<link rel=preload> must have a valid 'as' value`
 *
 * 两处都得改写：
 *   1. SSR HTML 的 `<link rel="preload" as="stylesheet">`
 *   2. 内联 FLIGHT_DATA 的 RSC 提示行 `<id>:HL["href","stylesheet"]`
 *
 * 不依赖 plugin-rsc 虚拟模块，可独立单测。
 */

const preloadStylesheetAsRe =
  /(<link\b(?=[^>]*\brel=(["'])preload\2)(?=[^>]*\bas=(["'])stylesheet\3)[^>]*?)\bas=(["'])stylesheet\4/gi;

// FLIGHT_DATA 是放在 `<script>__FLIGHT_DATA.push("...")</script>` 内的 JS 字符串字面量，
// JSON 里原本的 `"stylesheet"` 被转义成 `\"stylesheet\"`。
const flightHintStylesheetRe = /(:HL\[\\"[^\\"\n]+\\",)\\"stylesheet\\"/g;

export function rewritePreloadHints(html: string): string {
  return html
    .replace(preloadStylesheetAsRe, (_match, prefix, _relQuote, _asQuote, asAttrQuote) => {
      return `${prefix}as=${asAttrQuote}style${asAttrQuote}`;
    })
    .replace(flightHintStylesheetRe, '$1\\"style\\"');
}

export function standardizePreloadHints(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = carry + decoder.decode(chunk, { stream: true });
        // 任何尚未闭合的 `<link` 或 `:HL[` 都得留在 carry，否则正则会把半截 token 漏改。
        const linkStart = text.lastIndexOf('<link');
        const flightStart = text.lastIndexOf(':HL[');
        let splitAt = text.length;
        if (linkStart >= 0) splitAt = Math.min(splitAt, linkStart);
        if (flightStart >= 0) splitAt = Math.min(splitAt, flightStart);
        const ready = text.slice(0, splitAt);
        carry = text.slice(splitAt);
        if (ready) controller.enqueue(encoder.encode(rewritePreloadHints(ready)));
      },
      flush(controller) {
        const text = carry + decoder.decode();
        if (text) controller.enqueue(encoder.encode(rewritePreloadHints(text)));
      },
    })
  );
}
