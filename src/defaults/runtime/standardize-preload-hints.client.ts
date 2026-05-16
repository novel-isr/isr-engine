/**
 * standardize-preload-hints (client) —— 客户端 DOM 侧把
 *   <link rel="preload" as="stylesheet">
 * 改写成 HTML 标准的
 *   <link rel="preload" as="style">
 *
 * 为啥要客户端版本：
 *   server 侧的 standardize-preload-hints 走 stream rewrite，覆盖 SSR HTML +
 *   内联 FLIGHT_DATA 提示，prod 实测干净。但是 dev 模式下 plugin-rsc / Vite
 *   HMR / React 19 RSC client runtime 通过 JS 动态创建 <link> 元素（不走
 *   SSR 流），浏览器照样打 `<link rel=preload> must have a valid as value` 警告。
 *
 * 修法：拦截 HTMLLinkElement.prototype.as 的 setter + Element.prototype.setAttribute，
 * 当 link.rel === 'preload' 且 as 被赋成 'stylesheet' 时，自动改成 'style'。
 * 比 MutationObserver 早：在元素插入 DOM、浏览器开始预加载之前就改正确，警告不再触发。
 *
 * 仅 dev 必要 —— prod SSR rewriter 已经覆盖所有路径，但客户端 patch 在 prod 也
 * 无副作用（patch 检查严格匹配 preload + stylesheet，正常 stylesheet/style 不受影响）。
 */

let installed = false;

export function installClientPreloadHintFix(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof HTMLLinkElement === 'undefined') return;
  installed = true;

  // 1) patch HTMLLinkElement.as setter —— React DOM 用 `link.as = 'stylesheet'` 这种属性赋值
  const proto = HTMLLinkElement.prototype;
  const asDesc = Object.getOwnPropertyDescriptor(proto, 'as');
  if (asDesc?.set && asDesc.get) {
    const origSet = asDesc.set;
    Object.defineProperty(proto, 'as', {
      configurable: true,
      enumerable: asDesc.enumerable,
      get: asDesc.get,
      set(value: string) {
        // 注意：rel 可能还没设置；只在 rel === 'preload' 且 value === 'stylesheet' 时纠正
        const v =
          this.rel === 'preload' && String(value).toLowerCase() === 'stylesheet' ? 'style' : value;
        origSet.call(this, v);
      },
    });
  }

  // 2) patch Element.setAttribute —— 有些代码走 `link.setAttribute('as', 'stylesheet')`
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name: string, value: string): void {
    let fixedValue = value;
    if (
      name.toLowerCase() === 'as' &&
      String(value).toLowerCase() === 'stylesheet' &&
      this instanceof HTMLLinkElement &&
      (this.getAttribute('rel')?.toLowerCase() === 'preload' ||
        (this as HTMLLinkElement).rel === 'preload')
    ) {
      fixedValue = 'style';
    }
    return origSetAttribute.call(this, name, fixedValue);
  };
}
