/**
 * 主题自动注入 —— SSR 响应流里把决议好的 data-theme 写进 `<html>` 开标签。
 *
 * 跟 injectSeoMeta 同机制：TransformStream 边解码边匹配；命中开标签就改写一次，
 * 之后字节直通。匹配是大小写不敏感的，但属性写回时保留原字面（不重排其他 attribute）。
 *
 * 决议入参由调用方在请求级算好（理由：engine 入口已经把 cookie 解析进
 * RequestContext.cookies，调用方 1 行读一下就行；放到这里再读一遍会跨层）。
 */
import type { RuntimeThemeConfig } from '../../types/ISRConfig';

const HTML_OPEN_RE = /<html\b([^>]*)>/i;

export const DEFAULT_THEME_CONFIG: Required<RuntimeThemeConfig> = {
  cookieName: 'theme',
  attribute: 'data-theme',
  fallback: 'dark',
  values: ['light', 'dark'],
};

export function resolveThemeConfig(
  partial: RuntimeThemeConfig | undefined
): Required<RuntimeThemeConfig> {
  if (!partial) return { ...DEFAULT_THEME_CONFIG };
  return {
    cookieName: partial.cookieName ?? DEFAULT_THEME_CONFIG.cookieName,
    attribute: partial.attribute ?? DEFAULT_THEME_CONFIG.attribute,
    fallback: partial.fallback ?? DEFAULT_THEME_CONFIG.fallback,
    values: partial.values ?? DEFAULT_THEME_CONFIG.values,
  };
}

export interface ResolveThemeInput {
  cookies?: Record<string, string>;
  /** 响应头名 → 值（小写化的 key 命中 sec-ch-prefers-color-scheme） */
  headers?: Record<string, string>;
}

/**
 * 决议主题：cookie 命中 values 优先；否则看 Sec-CH-Prefers-Color-Scheme client hint；
 * 都没命中回 fallback。返回字符串，而不是固定 'light' | 'dark'，让消费方自定义 values。
 */
export function resolveTheme(input: ResolveThemeInput, cfg: Required<RuntimeThemeConfig>): string {
  const cookieVal = input.cookies?.[cfg.cookieName];
  if (cookieVal && cfg.values.includes(cookieVal)) return cookieVal;

  const hint = input.headers?.['sec-ch-prefers-color-scheme'];
  if (typeof hint === 'string') {
    const v = hint.replace(/"/g, '').toLowerCase();
    if (cfg.values.includes(v)) return v;
  }
  return cfg.fallback;
}

/**
 * SSR 响应流转换：找到 `<html ...>` 开标签，没 `data-theme` 时塞进去。
 *
 * - 业务自己已经写了 `data-theme="..."` 的 → 不覆盖（手动赋值最高优先级）
 * - 没找到 `<html>` 的（不大可能） → 流原样直通
 *
 * 跟 injectSeoMeta 一样用 SAFE_KEEP buffer 防 chunk 边界切到一半。
 */
export function injectHtmlTheme(
  source: ReadableStream<Uint8Array>,
  theme: string,
  cfg: Required<RuntimeThemeConfig>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const attrName = cfg.attribute;
  const attrPresentRe = new RegExp(`\\s${escapeRegex(attrName)}\\s*=`, 'i');

  let buffer = '';
  let injected = false;
  const SAFE_KEEP = 256;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const m = HTML_OPEN_RE.exec(buffer);
      if (m) {
        const fullTag = m[0];
        const innerAttrs = m[1] ?? '';
        const tagStart = m.index;
        const tagEnd = tagStart + fullTag.length;
        // 业务已经写了 data-theme → 流原样 + 标记完成
        const newOpen = attrPresentRe.test(innerAttrs)
          ? fullTag
          : `<html${innerAttrs} ${attrName}="${escapeAttr(theme)}">`;
        const out = buffer.slice(0, tagStart) + newOpen + buffer.slice(tagEnd);
        controller.enqueue(encoder.encode(out));
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
