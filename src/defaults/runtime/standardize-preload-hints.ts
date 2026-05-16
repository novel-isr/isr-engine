/**
 * standardize-preload-hints —— 在 SSR HTML 出流上做两件事，针对 plugin-rsc 默认行为：
 *
 *   1. 把 `<link rel="preload" as="stylesheet|style" href="*.css">` 升级成
 *      `<link rel="stylesheet" data-precedence="vite-rsc/importer-resources"
 *      href="*.css">` —— 让本路由的 CSS 在初始渲染就 **blocking 加载**，消除
 *      "Element render delay" 5+ 秒 的 LCP 问题。
 *
 *      为啥这条路是开箱即用：plugin-rsc 天然只为本次渲染用到的 chunk emit
 *      这些 preload（已经是 scoped-by-route），engine 把它们升级成 stylesheet
 *      就是 scoped blocking 注入 —— 不需要业务方暴露任何路由表，也不会带上
 *      跨路由 CSS。
 *
 *      `data-precedence` 用 'vite-rsc/importer-resources' 跟 plugin-rsc 自己 emit
 *      的对齐：React 19 hydrate 时按 href+precedence dedupe，stylesheet hoisting
 *      不会重复插入 link。
 *
 *   2. 把内联 FLIGHT_DATA 的 RSC 提示行 `<id>:HL["href","stylesheet"]` 里的
 *      `"stylesheet"` 改成 HTML 标准 `"style"` —— 浏览器 `<link rel=preload>`
 *      的 `as` 只接受 `style`，as=stylesheet 会触发控制台警告
 *      `must have a valid 'as' value`。
 *
 *      HTML 路径已经在 (1) 升级走了，FLIGHT_DATA 是给客户端 RSC payload
 *      navigation/hydrate 用的 hint，留下来仍然要做合规修正。
 *
 * 性能要点（2026-05 bench 回归 -50% QPS / +200ms p95 后修）：
 *   - SSR HTML 流 ~25 个 chunk，绝大多数不含 `stylesheet`
 *   - 旧实现对每个 chunk 都跑 decode / concat / 2× lastIndexOf / 2× slice /
 *     2× regex.replace / encode，全部花在了 pass-through 上
 *   - 现在的 fast path 用 byte 级 memmem 扫触发字面量，没命中且没 pending 时
 *     直接 enqueue 原始 Uint8Array（零分配、零拷贝）
 *   - 慢路径才走 decode + regex；命中之后逻辑保持原样
 *   - 跨 chunk 边界的 needle (sty|lesheet) 由 byte-tail carry 兜底，留 9 字节
 *
 * 不依赖 plugin-rsc 虚拟模块，可独立单测。
 */

const PRECEDENCE = 'vite-rsc/importer-resources';

// 整 tag 命中：rel=preload 且 as=stylesheet|style（顺序任意），用 lookahead 兼容
// 属性顺序变化（plugin-rsc 实测 rel 在前 as 在后，但不锁死）。
const preloadCssLinkTagRe =
  /<link\b(?=[^>]*\brel=(["'])preload\1)(?=[^>]*\bas=(["'])(?:stylesheet|style)\2)[^>]*>/gi;

// FLIGHT_DATA 是放在 `<script>__FLIGHT_DATA.push("...")</script>` 内的 JS 字符串字面量，
// JSON 里原本的 `"stylesheet"` 被转义成 `\"stylesheet\"`。
const flightHintStylesheetRe = /(:HL\[\\"[^\\"\n]+\\",)\\"stylesheet\\"/g;

// 三个触发字面量。任一出现 → 走慢路径（必须 decode + carry，不能边界丢字节）。
//   - "stylesheet" : 真正要被改写的目标字串
//   - "<link"      : 一旦出现就要 hold 整个 tag，避免 emit 一半再发现要改
//   - ":HL[" 的 :H : 一旦出现就要 hold 整个 hint row，理由同上
//
// 三个 needle 选最长（10 字节）的减一 = 9 字节，作为跨 chunk 边界的 byte-carry，
// 保证 `sty|lesheet` 这种切断模式仍能在下一轮 byte 扫描里命中。
const STYLESHEET_BYTES = new Uint8Array([
  // s    t    y    l    e    s    h    e    e    t
  0x73, 0x74, 0x79, 0x6c, 0x65, 0x73, 0x68, 0x65, 0x65, 0x74,
]);
const LINK_BYTES = new Uint8Array([
  // <    l    i    n    k
  0x3c, 0x6c, 0x69, 0x6e, 0x6b,
]);
const HL_BYTES = new Uint8Array([
  // :    H    L    [
  0x3a, 0x48, 0x4c, 0x5b,
]);

const PENDING_HOLD = STYLESHEET_BYTES.length - 1; // 9 字节，covers all three needles

/** 把单个 `<link rel=preload as=stylesheet|style ...>` tag 升级成 blocking stylesheet。
 *
 * 输入示例：`<link rel="preload" as="stylesheet" href="/assets/HomePage-x.css">`
 * 输出示例：`<link rel="stylesheet" data-precedence="vite-rsc/importer-resources" href="/assets/HomePage-x.css">`
 *
 * 保留 href / integrity / crossorigin / type / media 等其它属性；只剥 rel=preload + as=...。
 */
function upgradePreloadCssTag(tag: string): string {
  // 去掉前缀 "<link" 和后缀 ">"，得到属性段。
  const attrs = tag.slice(5, tag.endsWith('/>') ? -2 : -1);
  const stripped = attrs
    .replace(/\s+rel=(["'])preload\1/i, '')
    .replace(/\s+as=(["'])(?:stylesheet|style)\1/i, '')
    .trimEnd();
  // 拼接保证 rel + precedence 在前，方便人肉调试 + React 19 hydrate 解析。
  return `<link rel="stylesheet" data-precedence="${PRECEDENCE}"${stripped}>`;
}

export function rewritePreloadHints(html: string): string {
  return html
    .replace(preloadCssLinkTagRe, upgradePreloadCssTag)
    .replace(flightHintStylesheetRe, '$1\\"style\\"');
}

/**
 * 在 chunk 字节里找 needle。Node 22+ 的 Buffer.indexOf 走 SIMD memmem，
 * 比纯 JS 双循环快两个数量级；fallback 留给 Edge runtime。
 */
export function bytesIncludeAscii(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  // Node fast path
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
    return buf.indexOf(needle as unknown as Buffer) !== -1;
  }
  // 通用 fallback：朴素双循环。chunk ≤ 几十 KB，常量因子可接受。
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export function standardizePreloadHints(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let charCarry = ''; // 慢路径的字符串 carry（保留 <link / :HL[ 半截 token）
  let pendingTail: Uint8Array | null = null; // 快路径的字节 carry（最多 9 字节）

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength === 0) return;

        // 把上一轮压住的字节尾巴拼回来，让扫描跨过 chunk 边界。
        const combined = pendingTail ? concatBytes(pendingTail, chunk) : chunk;
        pendingTail = null;

        // SLOW PATH：上一轮还没收尾（charCarry 非空），或者本轮字节里命中了
        // 三个触发字面量任一（stylesheet / <link / :HL[）。先 decode 拼到
        // charCarry，再做安全切分。
        const triggered =
          charCarry.length > 0 ||
          bytesIncludeAscii(combined, STYLESHEET_BYTES) ||
          bytesIncludeAscii(combined, LINK_BYTES) ||
          bytesIncludeAscii(combined, HL_BYTES);
        if (triggered) {
          const text = charCarry + decoder.decode(combined, { stream: true });
          const linkStart = text.lastIndexOf('<link');
          const flightStart = text.lastIndexOf(':HL[');
          let splitAt = text.length;
          if (linkStart >= 0) splitAt = Math.min(splitAt, linkStart);
          if (flightStart >= 0) splitAt = Math.min(splitAt, flightStart);
          const ready = text.slice(0, splitAt);
          charCarry = text.slice(splitAt);
          if (ready) controller.enqueue(encoder.encode(rewritePreloadHints(ready)));
          return;
        }

        // FAST PATH：完全没命中。把 combined 的尾部 9 字节留作 pendingTail，
        // 其余直接 enqueue。零分配（subarray 是 view）。
        if (combined.byteLength <= PENDING_HOLD) {
          // chunk 太小，整块留作 carry，等下一轮再判
          pendingTail = combined.slice();
          return;
        }
        const emitLen = combined.byteLength - PENDING_HOLD;
        controller.enqueue(combined.subarray(0, emitLen));
        // pendingTail 必须独占 buffer：上游可能在 enqueue 后复用 chunk 内存。
        pendingTail = combined.slice(emitLen);
      },
      flush(controller) {
        // EOF：pendingTail 不可能再形成 needle，直接刷出。
        if (pendingTail && pendingTail.byteLength > 0) {
          controller.enqueue(pendingTail);
          pendingTail = null;
        }
        const text = charCarry + decoder.decode();
        if (text) controller.enqueue(encoder.encode(rewritePreloadHints(text)));
      },
    })
  );
}
