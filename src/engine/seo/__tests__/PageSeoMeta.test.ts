/**
 * PageSeoMeta + injectSeoMeta 单元测试
 *
 * 覆盖：
 *   - renderPageSeoMeta：title/desc/keywords/canonical/og/twitter/jsonLd 输出
 *   - HTML 转义防 XSS
 *   - alternates hreflang 多语言链接
 *   - injectSeoMeta：在 </head> 前插入；保持流式；跨 chunk 边界正确
 */
import { describe, it, expect } from 'vitest';
import { renderPageSeoMeta, type PageSeoMeta } from '../PageSeoMeta';
import { injectSeoMeta } from '../injectSeoMeta';

describe('renderPageSeoMeta', () => {
  it('输出 title / description / keywords', () => {
    const html = renderPageSeoMeta({
      title: 'Hello',
      description: 'desc',
      keywords: ['a', 'b'],
    });
    expect(html).toContain('<title>Hello</title>');
    expect(html).toContain('<meta name="description" content="desc">');
    expect(html).toContain('<meta name="keywords" content="a, b">');
  });

  it('转义 < > " & 防 XSS', () => {
    const html = renderPageSeoMeta({
      title: '<script>alert("x")</script>',
      description: 'a & b',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('noindex 输出 robots meta', () => {
    const html = renderPageSeoMeta({ noindex: true });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('canonical 优先于 baseUrl', () => {
    const html = renderPageSeoMeta({ canonical: 'https://canonical.com/x' }, 'https://base.com/y');
    expect(html).toContain('href="https://canonical.com/x"');
    expect(html).not.toContain('https://base.com/y');
  });

  it('相对 image 路径用 baseUrl 解析为绝对 URL（og 必须绝对）', () => {
    const html = renderPageSeoMeta({ image: '/covers/1.svg' }, 'https://novel.example.com');
    expect(html).toContain('og:image" content="https://novel.example.com/covers/1.svg"');
    expect(html).toContain('twitter:image" content="https://novel.example.com/covers/1.svg"');
  });

  it('相对 canonical 路径用 baseUrl 解析为绝对', () => {
    const html = renderPageSeoMeta({ canonical: '/books/1' }, 'https://novel.example.com');
    expect(html).toContain('canonical" href="https://novel.example.com/books/1"');
  });

  it('相对 alternates href 用 baseUrl 解析为绝对', () => {
    const html = renderPageSeoMeta(
      {
        alternates: [
          { hreflang: 'zh-CN', href: '/books/1' },
          { hreflang: 'en', href: '/en/books/1' },
        ],
      },
      'https://novel.example.com'
    );
    expect(html).toContain('hreflang="zh-CN" href="https://novel.example.com/books/1"');
    expect(html).toContain('hreflang="en" href="https://novel.example.com/en/books/1"');
  });

  it('已是绝对 URL 时不重复 resolve', () => {
    const html = renderPageSeoMeta(
      { image: 'https://cdn.com/x.png', canonical: 'https://other.com/y' },
      'https://novel.example.com'
    );
    expect(html).toContain('og:image" content="https://cdn.com/x.png"');
    expect(html).toContain('canonical" href="https://other.com/y"');
  });

  it('protocol-relative URL 也保持原样', () => {
    const html = renderPageSeoMeta({ image: '//cdn.com/x.png' }, 'https://novel.example.com');
    expect(html).toContain('og:image" content="//cdn.com/x.png"');
  });

  it('无 baseUrl 时相对路径原样输出（最大努力）', () => {
    const html = renderPageSeoMeta({ image: '/covers/1.svg' });
    expect(html).toContain('og:image" content="/covers/1.svg"');
  });

  it('alternates 输出 hreflang 链接', () => {
    const html = renderPageSeoMeta({
      alternates: [
        { hreflang: 'en', href: 'https://x.com/en' },
        { hreflang: 'zh-CN', href: 'https://x.com/zh' },
      ],
    });
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://x.com/en">');
    expect(html).toContain('<link rel="alternate" hreflang="zh-CN" href="https://x.com/zh">');
  });

  it('og:title / og:description / og:image 输出', () => {
    const html = renderPageSeoMeta({
      title: 'T',
      description: 'D',
      image: 'https://img.com/a.png',
    });
    expect(html).toContain('<meta property="og:title" content="T">');
    expect(html).toContain('<meta property="og:description" content="D">');
    expect(html).toContain('<meta property="og:image" content="https://img.com/a.png">');
    expect(html).toContain('<meta name="twitter:image" content="https://img.com/a.png">');
  });

  it('og:type 默认 website，可覆盖', () => {
    expect(renderPageSeoMeta({})).toContain('content="website"');
    expect(renderPageSeoMeta({ ogType: 'article' })).toContain('content="article"');
  });

  it('jsonLd 序列化为 ld+json script', () => {
    const html = renderPageSeoMeta({
      jsonLd: { '@type': 'Article', name: 'X' },
    });
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"name":"X"');
  });

  it('jsonLd 数组输出多个 script', () => {
    const html = renderPageSeoMeta({
      jsonLd: [{ a: 1 }, { b: 2 }],
    });
    expect(html.match(/<script type="application\/ld\+json">/g)?.length).toBe(2);
  });

  it('jsonLd 内的 </script> 被转义', () => {
    const html = renderPageSeoMeta({
      jsonLd: { x: '</script><script>alert(1)</script>' },
    });
    expect(html).not.toMatch(/<\/script>\s*<script>alert/);
    expect(html).toContain('<\\/script');
  });
});

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function htmlStream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

describe('injectSeoMeta', () => {
  const meta: PageSeoMeta = { title: 'INJ', description: 'X' };

  it('在 <head> 之后立刻插入（单 chunk）—— 比用户 <title> 更靠前', async () => {
    const src = htmlStream(['<html><head><title>USER</title></head><body>hi</body></html>']);
    const out = await streamToString(injectSeoMeta(src, meta));
    expect(out).toContain('<title>INJ</title>');
    // 关键：注入 title 出现在用户 title 之前 → 浏览器用 INJ
    expect(out.indexOf('<title>INJ</title>')).toBeLessThan(out.indexOf('<title>USER</title>'));
    expect(out).toContain('<body>hi</body>');
  });

  it('支持带属性的 <head> 标签', async () => {
    const src = htmlStream(['<html><head data-rsc="x"><body></body></html>']);
    const out = await streamToString(injectSeoMeta(src, meta));
    expect(out).toContain('<title>INJ</title>');
    expect(out.indexOf('<head data-rsc="x">')).toBeLessThan(out.indexOf('<title>INJ</title>'));
  });

  it('跨 chunk 边界正确处理（分裂 <head>）', async () => {
    const src = htmlStream(['<html><he', 'ad>', '<title>USER</title></head><body></body></html>']);
    const out = await streamToString(injectSeoMeta(src, meta));
    expect(out).toContain('<title>INJ</title>');
    expect(out.indexOf('<title>INJ</title>')).toBeLessThan(out.indexOf('<title>USER</title>'));
  });

  it('无 <head> 时原样输出，不抛错', async () => {
    const src = htmlStream(['<div>no head here</div>']);
    const out = await streamToString(injectSeoMeta(src, meta));
    expect(out).toBe('<div>no head here</div>');
  });

  it('只注入第一个 <head>', async () => {
    const src = htmlStream(['<head></head><head></head>']);
    const out = await streamToString(injectSeoMeta(src, meta));
    expect(out.match(/<title>INJ<\/title>/g)?.length).toBe(1);
  });
});
