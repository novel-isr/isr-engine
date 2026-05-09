/**
 * Head extras 注入 —— SSR HTML stream transformer，在 `<head>` 末尾（即 `</head>` 之前）
 * 把业务侧返回的 raw HTML 插进去。
 *
 * 用途：让业务侧塞 inline blocking script（theme init / GA snippet / A/B flag /
 * CSP nonce 等）到 head，**完全脱离 React 树** —— inline script 不进 client RSC payload，
 * 永远不会触发 React 19 + plugin-rsc 的 "head children mismatch" hydration 错误。
 *
 * 跟 SEO `injectSeoMeta` 同款 stream transformer 模式，区别只在插入位置：
 *   - SEO meta 抢首位（浏览器对 `<title>` 单值标签只取第一个） → 插 `<head>` 开标签之后
 *   - head extras 是业务自己的脚本，让它最后执行 → 插 `</head>` 之前
 *
 * stream 处理细节跟 SEO 对齐：TextDecoder 流式解码、256 字节滑动窗口防 chunk 切断、
 * 注入一次后直接透传后续 chunk，性能可接受。
 */

const HEAD_CLOSE_RE = /<\/head\s*>/i;

export function injectHeadExtras(
  source: ReadableStream<Uint8Array>,
  html: string
): ReadableStream<Uint8Array> {
  if (!html) return source;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const injection = '\n    ' + html + '\n  ';

  let buffer = '';
  let injected = false;
  // 防 `</head>` 被切成两段 —— 保留 256 字节滑动窗口
  const SAFE_KEEP = 256;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const m = HEAD_CLOSE_RE.exec(buffer);
      if (m) {
        const cutAt = m.index;
        const before = buffer.slice(0, cutAt);
        const after = buffer.slice(cutAt);
        controller.enqueue(encoder.encode(before + injection + after));
        buffer = '';
        injected = true;
        return;
      }
      if (buffer.length > SAFE_KEEP) {
        const emit = buffer.slice(0, buffer.length - SAFE_KEEP);
        buffer = buffer.slice(buffer.length - SAFE_KEEP);
        controller.enqueue(encoder.encode(emit));
      }
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      if (tail) controller.enqueue(encoder.encode(tail));
    },
  });

  return source.pipeThrough(transform);
}
