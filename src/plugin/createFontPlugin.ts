/**
 * createFontPlugin —— 字体优化 Vite 插件（构建时 + dev）
 *
 * 解决三个真实问题：
 *   1. **FOUT/FOIT**：所有 @font-face 强制注入 `font-display: swap`
 *      （没设的浏览器会 block ~3s 不渲染文本，严重伤 LCP）
 *   2. **CLS**：自上而下扫 CSS 的 @font-face 链接，注入 <link rel="preload">
 *      到 transformIndexHtml（让浏览器在 HTML parse 时就拉字体）
 *   3. **Google Fonts → 自托管**：可选 `google: ['Inter', 'Noto Sans SC']`
 *      构建时下载到 `public/_/fonts/`，避免运行时第三方阻塞 + GDPR 问题
 *
 * 业界对标：next/font 的子集（不做 size-adjust 推算 fallback metrics —— 那是
 * Capsize 的活，可作为后续增强；当前覆盖 80% 收益场景）。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Plugin, ResolvedConfig } from 'vite';

export interface FontPluginOptions {
  /** Google Fonts 家族名列表 —— 构建时下载到本地，避免运行时拉第三方 */
  google?: string[];
  /** 自托管字体目录（相对 public）；默认 '_/fonts' */
  outDir?: string;
  /** 关闭 font-display: swap 注入（极少需要，默认 true）*/
  injectSwap?: boolean;
  /** 关闭 preload 注入（默认 true）*/
  injectPreload?: boolean;
  /** 字重列表，仅对 google 有效；默认 ['400', '700'] */
  weights?: string[];
}

/** 匹配 @font-face 块的正则 —— 抓取整个块体用于字符串替换 */
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;

interface ParsedFace {
  family?: string;
  src?: string; // 第一个 url(...)，用于 preload
  weight?: string;
  style?: string;
}

function parseFontFace(block: string): ParsedFace {
  const get = (re: RegExp) =>
    block
      .match(re)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
  return {
    family: get(/font-family\s*:\s*([^;]+)/i),
    src: get(/url\(['"]?([^'")]+)['"]?\)/i),
    weight: get(/font-weight\s*:\s*([^;]+)/i),
    style: get(/font-style\s*:\s*([^;]+)/i),
  };
}

/** 字体格式 → preload 的 type 属性 */
function fontTypeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
  };
  return ext ? map[ext] : undefined;
}

export function createFontPlugin(options: FontPluginOptions = {}): Plugin {
  const injectSwap = options.injectSwap !== false;
  const injectPreload = options.injectPreload !== false;
  const weights = options.weights ?? ['400', '700'];
  const outRel = options.outDir ?? '_/fonts';

  let resolved: ResolvedConfig;
  /** 跨文件聚合 —— transform 阶段抓取，transformIndexHtml 注入 preload */
  const preloadUrls = new Set<string>();
  const generatedCss: string[] = []; // google fonts 自托管生成的 css

  return {
    name: 'novel-isr:font-optimization',
    enforce: 'post',
    configResolved(c) {
      resolved = c;
    },

    /** 构建启动前：下载 Google Fonts 到 public/<outDir>/ + 生成本地 @font-face CSS */
    async buildStart() {
      if (!options.google || options.google.length === 0) return;
      const publicDir = resolved.publicDir || path.resolve(resolved.root, 'public');
      const fontsDir = path.join(publicDir, outRel);
      await fs.mkdir(fontsDir, { recursive: true });

      for (const family of options.google) {
        const css = await downloadGoogleFontFamily(family, weights, fontsDir, outRel);
        if (css) generatedCss.push(css);
      }
    },

    /** 任何 CSS 文件经过 transform：注入 swap + 收集 preload url */
    transform(code, id) {
      if (!/\.(css|scss|less|sass|styl)(\?|$)/.test(id)) return null;
      let modified = false;
      const out = code.replace(FONT_FACE_RE, block => {
        const parsed = parseFontFace(block);
        if (parsed.src && injectPreload) preloadUrls.add(parsed.src);
        if (injectSwap && !/font-display\s*:/i.test(block)) {
          modified = true;
          return block.replace(/\}\s*$/, '  font-display: swap;\n}');
        }
        return block;
      });
      return modified ? { code: out, map: null } : null;
    },

    /** HTML 注入：preload 标签 + 自托管 google fonts 的 @font-face 块 */
    transformIndexHtml(html) {
      const tags: { tag: string; attrs?: Record<string, string>; injectTo?: 'head' }[] = [];

      if (generatedCss.length > 0) {
        // 内联 <style>，避免再发一次 CSS 请求
        tags.push({
          tag: 'style',
          attrs: { 'data-novel-isr-font': 'google' },
          injectTo: 'head',
        });
      }

      for (const url of preloadUrls) {
        tags.push({
          tag: 'link',
          attrs: {
            rel: 'preload',
            href: url,
            as: 'font',
            type: fontTypeFromUrl(url) ?? 'font/woff2',
            crossorigin: 'anonymous',
          },
          injectTo: 'head',
        });
      }

      if (tags.length === 0) return html;
      // vite transformIndexHtml 支持返回 tag 数组，但注入 style 子节点不能这样传
      // 直接字符串拼回：找 </head> 前
      const linkTags = tags
        .filter(t => t.tag === 'link')
        .map(
          t =>
            `<link ${Object.entries(t.attrs ?? {})
              .map(([k, v]) => `${k}="${v}"`)
              .join(' ')}>`
        )
        .join('\n    ');
      const styleTag =
        generatedCss.length > 0
          ? `<style data-novel-isr-font="google">${generatedCss.join('\n')}</style>`
          : '';
      const inject = `${linkTags}\n    ${styleTag}\n`;
      return html.replace('</head>', `    ${inject}</head>`);
    },
  };
}

/**
 * Google Fonts 家族下载 —— 通过 css2 API 拉 CSS，再下载里面所有 url(.woff2)
 *
 * 不用第三方 SDK：直接 HTTP，避开 GDPR + 锁版本风险
 */
async function downloadGoogleFontFamily(
  family: string,
  weights: string[],
  outDir: string,
  publicRel: string
): Promise<string | null> {
  const cssUrl =
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(family).replace(/%20/g, '+') +
    `:wght@${weights.join(';')}&display=swap`;
  try {
    const cssRes = await fetch(cssUrl, {
      headers: {
        // 关键：UA 影响返回的 src（默认是 woff2）
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    if (!cssRes.ok) {
      console.warn(`[font-plugin] Google Fonts ${family} 拉取失败: ${cssRes.status}`);
      return null;
    }
    let css = await cssRes.text();
    const urls = Array.from(css.matchAll(/url\((https:\/\/[^)]+)\)/g)).map(m => m[1]);

    for (const u of urls) {
      const r = await fetch(u);
      if (!r.ok) continue;
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const ext = u.split('.').pop()?.split('?')[0] || 'woff2';
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
      const fname = `${family.replace(/\s+/g, '-')}-${hash}.${ext}`;
      const localPath = path.join(outDir, fname);
      await fs.writeFile(localPath, buf);
      const publicUrl = `/${publicRel}/${fname}`;
      css = css.replace(u, publicUrl);
    }
    return css;
  } catch (err) {
    console.warn(`[font-plugin] ${family} 下载异常`, err);
    return null;
  }
}
