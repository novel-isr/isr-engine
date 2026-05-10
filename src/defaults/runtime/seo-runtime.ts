/**
 * SEO + i18n 运行时载荷类型 + 注入 helper
 *
 * 这些定义同时被两端消费：
 *   - engine 内部（src/engine/seo/* re-export 后给 SEOEngine 等用）
 *   - 用户的 plugin-rsc 构建里（src/defaults/* 在用户项目的 rsc 环境里被打包）
 *
 * 因此不能跨 `src/engine/...` 引用 —— pnpm `files` 字段只发布 `src/defaults/`。
 * 把运行时需要的部分集中在本文件里，根 index.ts 再 re-export 给公共表面使用。
 */

// ─── 类型 ──────────────────────────────────────────

export interface IntlPayload {
  /** BCP 47 语言标签，如 'en', 'zh-CN' */
  locale: string;
  /** 翻译消息字典 —— 结构由用户的 i18n 库决定 */
  messages: Record<string, unknown>;
  /** 文本方向；RTL 语言（ar/he）需设 'rtl'，默认 'ltr' */
  direction?: 'ltr' | 'rtl';
  /** 时区（用于日期格式化），默认 UTC */
  timeZone?: string;
  /** 诊断字段：标记消息来源，如 admin / local-fallback，便于 dev inspector 与响应头观测 */
  source?: string;
}

export interface PageSeoMeta {
  title?: string;
  description?: string;
  keywords?: string[];
  canonical?: string;
  image?: string;
  ogType?: 'website' | 'article' | 'product';
  noindex?: boolean;
  alternates?: Array<{ hreflang: string; href: string }>;
  jsonLd?: object | object[];
}

export function mergePageSeoMeta(
  base: PageSeoMeta | null | undefined,
  override: PageSeoMeta | null | undefined
): PageSeoMeta | null {
  if (!base) return override ?? null;
  if (!override) return base;
  return {
    ...base,
    ...override,
    keywords: override.keywords ?? base.keywords,
    alternates: override.alternates ?? base.alternates,
    jsonLd: override.jsonLd ?? base.jsonLd,
  };
}

// ─── PageSeoMeta → HTML 片段 ───────────────────────

/**
 * 把相对 URL 用 baseUrl 解析成绝对 URL
 * og:image / canonical / twitter:image / alternates.href 必须是绝对 URL
 * —— 社交爬虫（Facebook/Twitter/微信/LinkedIn）不会基于页面 URL resolve 相对路径
 */
function toAbsolute(href: string, baseUrl?: string): string {
  if (!href) return href;
  // 已是绝对 URL（含 protocol 或 //）
  if (/^(https?:)?\/\//i.test(href)) return href;
  if (!baseUrl) return href; // 没 baseUrl 只能原样输出（降级）
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export function renderPageSeoMeta(meta: PageSeoMeta, baseUrl?: string): string {
  const tags: string[] = [];
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 所有 engine 注入的 head 节点都打 data-isr-seo 标，客户端导航时按 marker 精准替换，
  // 不动业务/插件自己加的 meta（详见 applySeoToDocument 注释）。
  // <title> 是单值元素由 document.title 直接管理，不打标。
  if (meta.title) tags.push(`<title>${esc(meta.title)}</title>`);
  if (meta.description) {
    tags.push(`<meta data-isr-seo name="description" content="${esc(meta.description)}">`);
  }
  if (meta.keywords?.length) {
    tags.push(`<meta data-isr-seo name="keywords" content="${esc(meta.keywords.join(', '))}">`);
  }
  if (meta.noindex) {
    tags.push(`<meta data-isr-seo name="robots" content="noindex, nofollow">`);
  }
  if (meta.canonical || baseUrl) {
    const href = toAbsolute(meta.canonical || '', baseUrl) || baseUrl || '';
    if (href) tags.push(`<link data-isr-seo rel="canonical" href="${esc(href)}">`);
  }
  if (meta.alternates?.length) {
    for (const a of meta.alternates) {
      tags.push(
        `<link data-isr-seo rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(toAbsolute(a.href, baseUrl))}">`
      );
    }
  }
  if (meta.title) {
    tags.push(`<meta data-isr-seo property="og:title" content="${esc(meta.title)}">`);
  }
  if (meta.description) {
    tags.push(`<meta data-isr-seo property="og:description" content="${esc(meta.description)}">`);
  }
  tags.push(`<meta data-isr-seo property="og:type" content="${meta.ogType ?? 'website'}">`);
  if (meta.image) {
    const abs = toAbsolute(meta.image, baseUrl);
    tags.push(`<meta data-isr-seo property="og:image" content="${esc(abs)}">`);
    tags.push(`<meta data-isr-seo name="twitter:image" content="${esc(abs)}">`);
  }
  if (meta.jsonLd) {
    const arr = Array.isArray(meta.jsonLd) ? meta.jsonLd : [meta.jsonLd];
    for (const obj of arr) {
      const json = JSON.stringify(obj).replace(/<\/script/gi, '<\\/script');
      tags.push(`<script data-isr-seo="jsonld" type="application/ld+json">${json}</script>`);
    }
  }
  return tags.join('\n    ');
}

// ─── 流式注入：在 <head> 开标签**之后**立刻插入 ────────────
// 关键：浏览器对 <title> 等单值元素只用 head 中的**第一个**，所以注入必须最先出现。
// 老实现是在 </head> 之前 append，结果用户 SSR 的 <title> 会先出现并胜出 → SEO 失效。
// 现在正则匹配 `<head ...>`（含属性）后立刻塞入用户的 PageSeoMeta。

const HEAD_OPEN_RE = /<head\b[^>]*>/i;

export function injectSeoMeta(
  source: ReadableStream<Uint8Array>,
  meta: PageSeoMeta,
  baseUrl?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const injection = '\n    ' + renderPageSeoMeta(meta, baseUrl) + '\n';

  let buffer = '';
  let injected = false;
  // 防止 <head 被切成两个 chunk —— 保留尾部窗口
  const SAFE_KEEP = 256;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const m = HEAD_OPEN_RE.exec(buffer);
      if (m) {
        const cutAt = m.index + m[0].length;
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

// ─── 客户端导航后同步 <head> ──────────────────────────────────────────────
//
// 首屏 SSR 走 injectSeoMeta（HTML 流注入 <title> / <meta>）。
// 但 RSC 客户端导航（pushState + 拉新 RSC payload）只换 React 树，<head> 不会自动跟。
// Next.js / Remix / Astro 同样的问题，做法都是把页面的 metadata 序列化进 RSC payload，
// 客户端在每次 setPayload 之后把 metadata 应用到 document（title / meta / link / jsonLd）。
//
// 本函数只在浏览器调用：业务侧通常不直接 import，engine 客户端 entry 自动调用。
//
// 关键点：
//   - 用 `data-isr-seo` 标记本函数管理的 <head> 节点，避免误删用户/插件加的 meta
//   - 先按 `data-isr-seo` 抓出旧节点，再按 meta 重建写回（删→建，避免顺序漂移）
//   - jsonLd 也一并管，按 data-isr-seo='jsonld' 标记 + 全删全建
//   - 初次调用（即 SSR 注入的初始 head）首先把已有的 <title> / <meta> / <link> / 含
//     SSR injection marker 的节点打 data-isr-seo 标，让后续导航能精准替换
export function applySeoToDocument(meta: PageSeoMeta | null | undefined, baseUrl?: string): void {
  if (typeof document === 'undefined') return;
  if (!meta) return;
  const head = document.head;
  if (!head) return;

  // 1. 删除上一次本函数写入的所有 SEO 节点（按 marker）
  head.querySelectorAll('[data-isr-seo]').forEach(el => el.remove());

  // 2. title 单独管 —— 只用 document.title 赋值（不创建第二个 <title>）
  if (meta.title) document.title = meta.title;

  // 3. 用与 renderPageSeoMeta 相同的逻辑重建 head 节点（保持 SSR / 客户端语义一致）
  const fragments: HTMLElement[] = [];
  const tag = (name: 'meta' | 'link' | 'script', attrs: Record<string, string>): HTMLElement => {
    const el = document.createElement(name);
    el.setAttribute('data-isr-seo', '');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  if (meta.description) {
    fragments.push(tag('meta', { name: 'description', content: meta.description }));
  }
  if (meta.keywords?.length) {
    fragments.push(tag('meta', { name: 'keywords', content: meta.keywords.join(', ') }));
  }
  if (meta.noindex) {
    fragments.push(tag('meta', { name: 'robots', content: 'noindex, nofollow' }));
  }
  if (meta.canonical || baseUrl) {
    const href = toAbsolute(meta.canonical || '', baseUrl) || baseUrl || '';
    if (href) fragments.push(tag('link', { rel: 'canonical', href }));
  }
  if (meta.alternates?.length) {
    for (const a of meta.alternates) {
      fragments.push(
        tag('link', { rel: 'alternate', hreflang: a.hreflang, href: toAbsolute(a.href, baseUrl) })
      );
    }
  }
  if (meta.title) {
    fragments.push(tag('meta', { property: 'og:title', content: meta.title }));
  }
  if (meta.description) {
    fragments.push(tag('meta', { property: 'og:description', content: meta.description }));
  }
  fragments.push(tag('meta', { property: 'og:type', content: meta.ogType ?? 'website' }));
  if (meta.image) {
    const abs = toAbsolute(meta.image, baseUrl);
    fragments.push(tag('meta', { property: 'og:image', content: abs }));
    fragments.push(tag('meta', { name: 'twitter:image', content: abs }));
  }
  if (meta.jsonLd) {
    const arr = Array.isArray(meta.jsonLd) ? meta.jsonLd : [meta.jsonLd];
    for (const obj of arr) {
      const script = document.createElement('script');
      script.setAttribute('data-isr-seo', 'jsonld');
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify(obj).replace(/<\/script/gi, '<\\/script');
      fragments.push(script);
    }
  }

  for (const el of fragments) head.appendChild(el);
}
