/**
 * createFontPlugin 单元测试
 *
 * 覆盖：
 *   - transform：未含 font-display 的 @font-face 注入 swap
 *   - transform：已含 font-display 不重复注入
 *   - transform：抓取 url(...) 进 preloadUrls
 *   - transformIndexHtml：注入 <link rel="preload">
 *   - 跳过非 CSS 文件
 *   - injectSwap=false 时不注入
 */
import { describe, it, expect } from 'vitest';
import { createFontPlugin } from '../createFontPlugin';

interface PluginInternal {
  transform?: (this: unknown, code: string, id: string) => { code: string; map: null } | null;
  transformIndexHtml?: (this: unknown, html: string) => string;
}

describe('createFontPlugin', () => {
  it.each([
    ["@font-face { font-family: 'İ'; src: URL('/unicode.woff2'); }", '/unicode.woff2'],
    ["@font-face { src: url('/first.woff2'), url('/second.woff2'); }", '/first.woff2'],
  ])('preloads the first complete URL without changing character offsets', (css, expected) => {
    const plugin = createFontPlugin() as unknown as PluginInternal;
    plugin.transform!.call({}, css, 'app.css');
    expect(plugin.transformIndexHtml!.call({}, '<head></head>')).toContain(`href="${expected}"`);
  });

  it('ignores commented font rules and keeps quoted braces and URL parentheses intact', () => {
    const plugin = createFontPlugin() as unknown as PluginInternal;
    const css = `/* @font-face { src: url('/comment.woff2'); } */
@font-face { font-family: "Curly } Name"; src: url("/font(foo).woff2"); }`;
    const out = plugin.transform!.call({}, css, 'app.css');
    expect(out?.code).toContain('font-family: "Curly } Name"; src: url("/font(foo).woff2");');
    const html = plugin.transformIndexHtml!.call({}, '<head></head>');
    expect(html).toContain('href="/font(foo).woff2"');
    expect(html).not.toContain('/comment.woff2');
  });

  it('decodes CSS URL escapes and escapes preload HTML attributes', () => {
    const plugin = createFontPlugin() as unknown as PluginInternal;
    const css = String.raw`@font-face { src: url("/fonts/quote\"font.woff2"); }`;
    const out = plugin.transform!.call({}, css, 'app.css');
    expect(out?.code).toContain(String.raw`url("/fonts/quote\"font.woff2")`);
    expect(plugin.transformIndexHtml!.call({}, '<head></head>')).toContain(
      'href="/fonts/quote&quot;font.woff2"'
    );
  });

  it('inserts a declaration after an unterminated final declaration inside an unknown at-rule', () => {
    const plugin = createFontPlugin() as unknown as PluginInternal;
    const css = `@custom-theme example { @font-face { /* font-display: block */ src: url('/last.woff2') } }`;
    const out = plugin.transform!.call({}, css, 'app.css');
    expect(out?.code).toContain("src: url('/last.woff2') ;  font-display: swap;");
    expect(out?.code).toContain('@custom-theme example {');
    expect(plugin.transformIndexHtml!.call({}, '<head></head>')).toContain('href="/last.woff2"');
  });

  it('注入 font-display: swap', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    const css = `@font-face { font-family: 'X'; src: url('/x.woff2') format('woff2'); }`;
    const out = p.transform!.call({}, css, 'app.css');
    expect(out?.code).toContain('font-display: swap;');
  });

  it('已含 font-display 不重复注入', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    const css = `@font-face { font-family: 'X'; src: url('/x.woff2'); font-display: optional; }`;
    const out = p.transform!.call({}, css, 'app.css');
    // 不修改：返回 null
    expect(out).toBeNull();
  });

  it('收集 url(...) 到 preloadUrls 并在 HTML 注入 preload', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    const css = `@font-face { font-family: 'Inter'; src: url('/fonts/inter.woff2') format('woff2'); }`;
    p.transform!.call({}, css, 'a.css');
    const html = p.transformIndexHtml!.call({}, '<html><head></head><body></body></html>');
    expect(html).toContain('rel="preload"');
    expect(html).toContain('href="/fonts/inter.woff2"');
    expect(html).toContain('as="font"');
    expect(html).toContain('type="font/woff2"');
    expect(html).toContain('crossorigin="anonymous"');
  });

  it('跳过非 CSS 文件', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    const out = p.transform!.call({}, '@font-face {}', 'app.tsx');
    expect(out).toBeNull();
  });

  it('injectSwap=false 时不注入', () => {
    const p = createFontPlugin({ injectSwap: false }) as unknown as PluginInternal;
    const css = `@font-face { font-family: 'X'; src: url('/x.woff2'); }`;
    const out = p.transform!.call({}, css, 'a.css');
    expect(out).toBeNull(); // 没有修改
  });

  it('injectPreload=false 时 HTML 不注入 preload', () => {
    const p = createFontPlugin({ injectPreload: false }) as unknown as PluginInternal;
    const css = `@font-face { font-family: 'X'; src: url('/x.woff2'); }`;
    p.transform!.call({}, css, 'a.css');
    const html = p.transformIndexHtml!.call({}, '<html><head></head></html>');
    expect(html).not.toContain('rel="preload"');
  });

  it('多种字体格式都识别 type', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    p.transform!.call({}, `@font-face { src: url('/a.woff2'); }`, 'a.css');
    p.transform!.call({}, `@font-face { src: url('/b.ttf'); }`, 'b.css');
    const html = p.transformIndexHtml!.call({}, '<html><head></head></html>');
    expect(html).toContain('type="font/woff2"');
    expect(html).toContain('type="font/ttf"');
  });

  it('SCSS / Less 也走 transform', () => {
    const p = createFontPlugin() as unknown as PluginInternal;
    const css = `@font-face { font-family: 'X'; src: url('/x.woff2'); }`;
    expect(p.transform!.call({}, css, 'a.scss')).not.toBeNull();
    expect(p.transform!.call({}, css, 'a.less')).not.toBeNull();
  });
});
