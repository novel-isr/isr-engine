/**
 * standardize-preload-hints (client) —— 客户端 DOM 侧把
 *   <link rel="preload" as="stylesheet">
 * 改写成 HTML 标准且可复用的
 *   <link rel="preload" as="style" crossorigin="anonymous">
 *
 * 为啥要客户端版本：
 *   server 侧的 standardize-preload-hints 走 stream rewrite，覆盖 SSR HTML +
 *   内联 FLIGHT_DATA 提示，prod 实测干净。但是 dev 模式下 plugin-rsc / Vite
 *   HMR / React 19 RSC client runtime 通过 JS 动态创建 <link> 元素（不走
 *   SSR 流），浏览器照样打 `<link rel=preload> must have a valid as value` 警告。
 *
 * 修法：拦截 HTMLLinkElement.prototype.as / rel setter + Element.prototype.setAttribute，
 * 只要 link 是 CSS preload，就自动标准化成 as=style + crossorigin=anonymous。
 *
 * crossorigin 的原因：RSC 客户端导航会先插 preload，React 后续再插 stylesheet。
 * 如果两者 credentials mode 不一致，Chrome 会报：
 *   A preload ... is found, but is not used because the request credentials mode does not match
 * 并重新请求 CSS。CSS preload 必须和后续 stylesheet 的 CORS/credentials 语义一致。
 *
 * 比 MutationObserver 早：在元素插入 DOM、浏览器开始预加载之前就改正确，警告不再触发。
 *
 * 仅 dev 必要 —— prod SSR rewriter 已经覆盖所有路径，但客户端 patch 在 prod 也
 * 无副作用（patch 检查严格匹配 preload + stylesheet，正常 stylesheet/style 不受影响）。
 */

let installed = false;

function normalizeCssPreloadLink(link: HTMLLinkElement): void {
  if (link.rel.toLowerCase() !== 'preload') return;
  const as = link.getAttribute('as')?.toLowerCase() ?? link.as?.toLowerCase();
  if (as !== 'stylesheet' && as !== 'style') return;

  if (as !== 'style') link.setAttribute('as', 'style');
  if (!link.hasAttribute('crossorigin')) link.setAttribute('crossorigin', 'anonymous');
}

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
        normalizeCssPreloadLink(this);
      },
    });
  }

  // 2) patch HTMLLinkElement.rel setter —— 覆盖属性赋值顺序为 as → rel 的路径。
  const relDesc = Object.getOwnPropertyDescriptor(proto, 'rel');
  if (relDesc?.set && relDesc.get) {
    const origSet = relDesc.set;
    Object.defineProperty(proto, 'rel', {
      configurable: true,
      enumerable: relDesc.enumerable,
      get: relDesc.get,
      set(value: string) {
        origSet.call(this, value);
        normalizeCssPreloadLink(this);
      },
    });
  }

  // 3) patch Element.setAttribute —— 有些代码走 `link.setAttribute('as', 'stylesheet')`
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
    origSetAttribute.call(this, name, fixedValue);
    if (this instanceof HTMLLinkElement) normalizeCssPreloadLink(this);
  };
}
