/**
 * error500-template 单元测试
 *
 * 这层只验证：
 *   - HTML 结构有效（含 <!DOCTYPE>、charset、viewport、noindex）
 *   - traceId 出现在响应中
 *   - traceId 中的 HTML 特殊字符被转义（XSS 防御）
 *   - 空 traceId 时显示 'unknown'
 *   - 不依赖任何 runtime / DOM —— 纯字符串模板
 */
import { describe, it, expect } from 'vitest';
import { renderError500Html } from '../error500-template';

describe('renderError500Html', () => {
  it('返回完整 HTML 文档（含 doctype / charset / viewport）', () => {
    const html = renderError500Html('abc-123');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('viewport');
    expect(html).toContain('<title>');
  });

  it('含 noindex 防止搜索引擎收录错误页', () => {
    const html = renderError500Html('x');
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex,nofollow">/);
  });

  it('traceId 出现在响应中', () => {
    const html = renderError500Html('trace-xyz-789');
    expect(html).toContain('trace-xyz-789');
  });

  it('XSS 防御：traceId 含 < > " & 等字符被转义', () => {
    const evil = `<script>alert(1)</script>"&'`;
    const html = renderError500Html(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;');
  });

  it('空 traceId → 显示 unknown', () => {
    expect(renderError500Html('')).toContain('unknown');
    expect(renderError500Html(undefined)).toContain('unknown');
  });

  it('返回首页链接 + 重试按钮', () => {
    const html = renderError500Html('x');
    expect(html).toMatch(/href="\/"/);
    expect(html).toMatch(/onclick="location\.reload\(\)"/);
  });

  it('零依赖：模板不引用 React / window / process', () => {
    const html = renderError500Html('x');
    expect(html).not.toContain('React');
    expect(html).not.toContain('window.');
    expect(html).not.toContain('process.');
  });

  it('体积合理（< 4KB，确保即使 OOM 兜底也能写出去）', () => {
    const html = renderError500Html('a-very-long-trace-id-with-some-data-1234567890abcdef');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(4096);
  });
});
