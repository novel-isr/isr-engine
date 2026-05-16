/**
 * standardize-preload-hints.client 单测（setAttribute 路径）
 *
 * 注：jsdom 不实现 HTMLLinkElement.as 的 IDL setter（真浏览器 Chrome / Firefox
 * 都实现），所以 `link.as = ...` 在 jsdom 里只是普通 JS 属性赋值，**不调用**
 * setter，因此 jsdom 里测不到 .as setter 路径。这条路径靠真浏览器集成验证。
 *
 * setAttribute 路径在 jsdom 跟真浏览器都实现，可单测。React DOM 在 server
 * resource hoisting 和 hint flush 走的都是 setAttribute，所以 setAttribute 路径
 * 是主流量径。
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { installClientPreloadHintFix } from '../standardize-preload-hints.client';

// patch 是 module-level 全局，整套 test 一次安装就够；不在每个 test 后 restore
// （restore 后 installed 标志还在 → 后续 test install no-op → 假阴性）。
beforeAll(() => {
  installClientPreloadHintFix();
});

describe('installClientPreloadHintFix (setAttribute 路径)', () => {
  it('rel=preload + as=stylesheet → 自动改成 as=style', () => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'preload');
    link.setAttribute('as', 'stylesheet');
    expect(link.getAttribute('as')).toBe('style');
  });

  it('rel != preload 时不改 (兼容 rel=stylesheet 等合法用法)', () => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('as', 'stylesheet');
    expect(link.getAttribute('as')).toBe('stylesheet');
  });

  it('已合法的 as=style / as=image 透传不变', () => {
    const link1 = document.createElement('link');
    link1.setAttribute('rel', 'preload');
    link1.setAttribute('as', 'style');
    expect(link1.getAttribute('as')).toBe('style');

    const link2 = document.createElement('link');
    link2.setAttribute('rel', 'preload');
    link2.setAttribute('as', 'image');
    expect(link2.getAttribute('as')).toBe('image');
  });

  it('attribute 名大小写不敏感 (AS) + value 不敏感 (STYLESHEET) 都纠正', () => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'preload');
    link.setAttribute('AS', 'STYLESHEET');
    // jsdom 把 attribute name lowercase 存储，getAttribute('as') 拿到改后值
    expect(link.getAttribute('as')).toBe('style');
  });
});
