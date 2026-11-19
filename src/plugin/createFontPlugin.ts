/**
 * createFontPlugin —— 字体优化 Vite 插件（构建时 + dev）
 *
 * 解决三个真实问题：
 *   1. **FOUT/FOIT**：所有 @font-face 强制注入 `font-display: swap`
 *      （没设的浏览器会 block ~3s 不渲染文本，严重伤 LCP）
 *   2. **CLS**：自上而下扫 CSS 的 @font-face 链接，注入 <link rel="preload">
 *      到 transformIndexHtml（让浏览器在 HTML parse 时就拉字体）
 *   3. **Google Fonts → 自托管**：可选 `google: ['Inter', 'Noto Sans SC']`
 *      构建时输出字体资源、开发时从内存提供，避免运行时第三方阻塞
 *
 * 业界对标：next/font 的子集（不做 size-adjust 推算 fallback metrics —— 那是
 * Capsize 的活，可作为后续增强；当前覆盖 80% 收益场景）。
 */
import path from 'node:path';
import type { Environment, Plugin, ResolvedConfig } from 'vite';
import { parse, walk } from 'css-tree';
import {
  loadGoogleFontAssets,
  normalizeFontOutDir,
  renderGoogleFontCss,
  type GoogleFontAssets,
} from './googleFontAssets';

export interface FontPluginOptions {
  /** Google Fonts 家族名列表 —— 构建时下载到本地，避免运行时拉第三方 */
  google?: string[];
  /** 自托管字体资源目录（相对构建输出）；默认 '_/fonts' */
  outDir?: string;
  /** 关闭 font-display: swap 注入（极少需要，默认 true）*/
  injectSwap?: boolean;
  /** 关闭 preload 注入（默认 true）*/
  injectPreload?: boolean;
  /** 字重列表，仅对 google 有效；默认 ['400', '700'] */
  weights?: string[];
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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

interface FontSession {
  config?: ResolvedConfig;
  preloadUrls: Set<string>;
  shutdown: AbortController;
  devAssets: Map<string, Buffer>;
  starts: Map<object, Promise<void>>;
  assets?: GoogleFontAssets;
  downloading?: Promise<GoogleFontAssets>;
}

function createSession(config?: ResolvedConfig): FontSession {
  return {
    config,
    preloadUrls: new Set(),
    shutdown: new AbortController(),
    devAssets: new Map(),
    starts: new Map(),
  };
}

export function createFontPlugin(options: FontPluginOptions = {}): Plugin {
  const injectSwap = options.injectSwap !== false;
  const injectPreload = options.injectPreload !== false;
  const weights = [...(options.weights ?? ['400', '700'])];
  const families = [...(options.google ?? [])];
  const outRel = normalizeFontOutDir(options.outDir ?? '_/fonts');

  // Vite restarts may initialize the replacement before closing the old server.
  // Hooks and cleanup must keep their own configuration's session throughout that overlap.
  const sessions = new WeakMap<ResolvedConfig, FontSession>();
  let current = createSession();

  function sessionFor(config?: ResolvedConfig): FontSession {
    return (config ? sessions.get(config) : undefined) ?? current;
  }

  function environmentSession(environment?: Environment): FontSession {
    return sessionFor(environment?.getTopLevelConfig?.());
  }

  function assetUrl(session: FontSession, fileName: string, htmlPath = '/index.html'): string {
    const base = session.config?.base ?? '/';
    if (base === './' || base === '') {
      let entry = htmlPath.split(/[?#]/, 1)[0].replace(/^\/+/, '');
      if (!entry || entry.endsWith('/')) entry += 'index.html';
      const relative = path.posix.relative(path.posix.dirname(entry), fileName);
      return relative.startsWith('.') ? relative : `./${relative}`;
    }
    return `${base.endsWith('/') ? base : `${base}/`}${fileName}`;
  }

  function ensureAssets(session: FontSession): Promise<GoogleFontAssets> {
    session.shutdown.signal.throwIfAborted();
    return (session.downloading ??= loadGoogleFontAssets(
      families,
      weights,
      outRel,
      session.shutdown.signal
    )
      .then(bundle => {
        session.shutdown.signal.throwIfAborted();
        session.assets = bundle;
        if (session.config?.command === 'serve')
          for (const [fileName, bytes] of bundle.assets) {
            session.devAssets.set(
              new URL(assetUrl(session, fileName), 'http://font-assets.invalid').pathname,
              bytes
            );
          }
        return bundle;
      })
      .catch(error => {
        session.downloading = undefined;
        throw error;
      }));
  }

  function dispose(session: FontSession): void {
    session.shutdown.abort(new Error('Google font asset session closed'));
    session.assets = undefined;
    session.downloading = undefined;
    session.devAssets.clear();
    session.starts.clear();
    session.preloadUrls.clear();
  }

  return {
    name: 'isr-engine:font-optimization',
    enforce: 'post',
    sharedDuringBuild: true,
    configResolved(c) {
      current = createSession(c);
      sessions.set(c, current);
    },

    /** Share validated downloads across environments; only client outputs own browser assets. */
    async buildStart() {
      const session = environmentSession(this.environment);
      if (
        !families.length ||
        (session.config?.command === 'build' && this.environment?.config.consumer === 'server')
      )
        return;
      const key = this.environment ?? this;
      let pending = session.starts.get(key);
      if (!pending) {
        pending = (async () => {
          const bundle = await ensureAssets(session);
          session.shutdown.signal.throwIfAborted();
          if (session.config?.command === 'build')
            for (const [fileName, source] of bundle.assets)
              this.emitFile({ type: 'asset', fileName, source });
        })();
        session.starts.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (session.starts.get(key) === pending) session.starts.delete(key);
      }
    },

    configureServer(server) {
      const session = sessionFor(server.config);
      server.httpServer?.once('close', () => dispose(session));
      server.middlewares.use((req, res, next) => {
        const bytes = session.devAssets.get((req.url ?? '').split(/[?#]/, 1)[0]);
        if (!bytes) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET, HEAD');
          res.end();
          return;
        }
        res.setHeader('content-type', 'font/woff2');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('content-length', bytes.length);
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        res.end(req.method === 'HEAD' ? undefined : bytes);
      });
    },
    closeBundle() {
      const session = environmentSession(this.environment);
      if (session.config?.command === 'serve') dispose(session);
    },
    closeWatcher() {
      const session = environmentSession(this.environment);
      if (session.config?.command === 'build' && this.environment?.config.consumer !== 'server')
        dispose(session);
    },

    /** 任何 CSS 文件经过 transform：注入 swap + 收集 preload url */
    transform(code, id) {
      const session = environmentSession(this.environment);
      if (!/\.(css|scss|less|sass|styl)(\?|$)/.test(id)) return null;
      // Parse CSS structure once; comments, strings and escaped URLs retain their meaning.
      // Edit only source offsets so formatting and syntax outside @font-face remain untouched.
      let stylesheet;
      try {
        stylesheet = parse(code, { positions: true });
      } catch {
        return null;
      }
      const insertions: number[] = [];
      walk(stylesheet, {
        visit: 'Atrule',
        enter(rule) {
          if (rule.name.toLowerCase() !== 'font-face' || !rule.block) return;
          let hasDisplay = false;
          let firstUrl: string | undefined;
          rule.block.children.forEach(declaration => {
            if (declaration.type !== 'Declaration') return;
            const property = declaration.property.toLowerCase();
            if (property === 'font-display') hasDisplay = true;
            if (property === 'src' && firstUrl === undefined) {
              walk(declaration.value, {
                visit: 'Url',
                enter(url) {
                  firstUrl ??= url.value;
                },
              });
            }
          });
          if (firstUrl && injectPreload) session.preloadUrls.add(firstUrl);
          const close = rule.block.loc ? rule.block.loc.end.offset - 1 : -1;
          if (injectSwap && !hasDisplay && code[close] === '}') insertions.push(close);
        },
      });
      if (insertions.length === 0) return null;
      const parts: string[] = [];
      let cursor = 0;
      for (const offset of insertions.sort((a, b) => a - b)) {
        parts.push(code.slice(cursor, offset), ';  font-display: swap;\n');
        cursor = offset;
      }
      parts.push(code.slice(cursor));
      return { code: parts.join(''), map: null };
    },

    /** HTML 注入：preload 标签 + 自托管 google fonts 的 @font-face 块 */
    transformIndexHtml(html, context) {
      const session = sessionFor(context?.server?.config);
      const render = () => {
        const generatedCss = session.assets
          ? renderGoogleFontCss(session.assets, fileName =>
              assetUrl(session, fileName, context?.path)
            )
          : '';
        const tags: { tag: string; attrs?: Record<string, string>; injectTo?: 'head' }[] = [];

        if (generatedCss) {
          // 内联 <style>，避免再发一次 CSS 请求
          tags.push({
            tag: 'style',
            attrs: { 'data-isr-engine-font': 'google' },
            injectTo: 'head',
          });
        }

        for (const url of session.preloadUrls) {
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
                .map(([k, v]) => `${k}="${escapeHtmlAttribute(v)}"`)
                .join(' ')}>`
          )
          .join('\n    ');
        const styleTag = generatedCss
          ? `<style data-isr-engine-font="google">${generatedCss}</style>`
          : '';
        const inject = `${linkTags}\n    ${styleTag}\n`;
        return html.replace('</head>', `    ${inject}</head>`);
      };
      // In dev the first HTML request can precede the first module's buildStart hook.
      if (families.length && !session.assets) return ensureAssets(session).then(render);
      return render();
    },
  };
}
