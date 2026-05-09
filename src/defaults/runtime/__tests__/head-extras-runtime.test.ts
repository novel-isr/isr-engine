/**
 * injectHeadExtras —— `<head>` 末尾注入 stream transformer 行为锁定。
 *
 * 关键不变量：
 *   - 注入位置：`</head>` **之前**（业务侧 inline script 在 SEO meta 之后执行）
 *   - 流式安全：`</head>` 被 chunk 切成两段时仍然能正确匹配
 *   - 空字符串 / undefined 透传不修改流（避免无意义的 transform 开销）
 *   - 没 `</head>` 标签时原样输出，不抛错（兜底鲁棒性）
 *   - 只匹配第一个 `</head>`（防 nested 标签 / 错误 HTML 二次注入）
 *
 * 跟 SEO injectSeoMeta 一样脱离 React 树，避免 plugin-rsc 在 client 端把 inline
 * script 从 RSC payload 里剔除导致的 head children mismatch 错误。
 */
import { describe, expect, it } from 'vitest';
import { injectHeadExtras } from '../head-extras-runtime';

const enc = new TextEncoder();
const dec = new TextDecoder();

function htmlStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function streamToString(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

const SCRIPT = '<script>document.documentElement.dataset.theme="dark";</script>';

describe('injectHeadExtras', () => {
  it('在 </head> 之前插入（单 chunk）', async () => {
    const src = htmlStream(['<html><head><title>X</title></head><body>hi</body></html>']);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out).toContain(SCRIPT);
    expect(out.indexOf(SCRIPT)).toBeLessThan(out.indexOf('</head>'));
    expect(out.indexOf('<title>X</title>')).toBeLessThan(out.indexOf(SCRIPT));
  });

  it('在 SEO meta 之后插入（保证 inline script 在 SEO 标签之后执行）', async () => {
    // 模拟 SEO 已经注入完的流：head 开头有 <title>SEO</title>
    const src = htmlStream([
      '<html><head><title>SEO</title><meta name="description" content="X"></head><body></body></html>',
    ]);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out.indexOf('<meta name="description"')).toBeLessThan(out.indexOf(SCRIPT));
    expect(out.indexOf(SCRIPT)).toBeLessThan(out.indexOf('</head>'));
  });

  it('支持带空格的 </head > 标签', async () => {
    const src = htmlStream(['<head></head ><body></body>']);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out).toContain(SCRIPT);
    expect(out.indexOf(SCRIPT)).toBeLessThan(out.indexOf('</head '));
  });

  it('跨 chunk 边界正确处理（分裂 </head>）', async () => {
    const src = htmlStream(['<html><head><title>X</title><', '/head>', '<body></body></html>']);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out).toContain(SCRIPT);
    expect(out.indexOf(SCRIPT)).toBeLessThan(out.indexOf('</head>'));
  });

  it('空字符串 / undefined 透传不修改流（避免无谓 transform）', async () => {
    const html = '<html><head></head><body>hi</body></html>';
    const out1 = await streamToString(injectHeadExtras(htmlStream([html]), ''));
    expect(out1).toBe(html);

    const out2 = await streamToString(
      injectHeadExtras(htmlStream([html]), undefined as unknown as string)
    );
    expect(out2).toBe(html);
  });

  it('无 </head> 时原样输出，不抛错', async () => {
    const src = htmlStream(['<div>no head close here</div>']);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out).toBe('<div>no head close here</div>');
  });

  it('只注入第一个 </head>（防错误 HTML 重复注入）', async () => {
    const src = htmlStream(['<head></head><head></head>']);
    const out = await streamToString(injectHeadExtras(src, SCRIPT));
    expect(out.match(/document\.documentElement/g)?.length).toBe(1);
  });

  it('inline script 内容原样透传（不 escape，业务侧自己负责安全）', async () => {
    const tricky = '<script>var x="</head>"; if(1<2) {}</script>';
    // 注：业务 hook 返回的 raw HTML 内部如果含 `</head>`，会破坏匹配 ——
    // 但插入位置是基于 source 流找的，inline 内容是塞进去的，不参与匹配。
    const src = htmlStream(['<html><head></head><body></body></html>']);
    const out = await streamToString(injectHeadExtras(src, tricky));
    expect(out).toContain(tricky);
  });
});
