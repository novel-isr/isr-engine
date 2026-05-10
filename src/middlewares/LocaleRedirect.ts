/**
 * Locale redirect 中间件 ——
 *
 * `runtime.i18n.prefixDefault: true` 时，根目录 / 业务路径裸 URL（无 locale 前缀）
 * 一律 302 到 `/{negotiated}/path`。negotiated 来源优先级：
 *   1. cookie 'locale'（用户上次切过的）
 *   2. Accept-Language 头协商（RFC 4647 lookup → 命中 i18n.locales 之一）
 *   3. i18n.defaultLocale
 *
 * 命中条件外的请求一概放行：
 *   - 已带 locale 前缀的 URL（/zh-CN/books 等）
 *   - 静态资源（含 . 的路径，比如 /favicon.ico、/_/img/abc.webp）
 *   - 框架内部端口 /api/*、/_rsc*、/health、/metrics、/sitemap.xml、/robots.txt
 *   - 非 GET / HEAD（POST 表单不走 302，否则丢 body）
 *
 * 这是路由层关切（locale code 怎么从 URL 解出 / 没有时怎么决议），engine 拥有
 * `parseLocale` / `negotiateLocale` 的同处，redirect 跟它们一起放最合适。
 */
import type { Request, Response, NextFunction } from 'express';
import type { I18nConfig } from '../runtime/i18n';
import { negotiateLocale, withLocale } from '../runtime/i18n';

export interface CreateLocaleRedirectOptions {
  i18n: I18nConfig;
  /** 跳过 redirect 的额外 path 前缀（业务自有 ops 路由等） */
  skipPathPrefixes?: readonly string[];
}

const FRAMEWORK_SKIP_PREFIXES = [
  '/api/',
  '/_rsc',
  '/_/',
  '/__',
  // ─── Vite dev server internal paths（绝对不能加 locale 前缀）─────────
  // vite 在 dev 时通过这些 URL 服务 module graph / HMR client / virtual modules
  // / 用户源文件 / pre-bundled deps；任何重写都会 404 或拿不到 module。
  '/@', // /@id/、/@vite/client、/@vite/env、/@fs/、/@react-refresh
  '/src/', // dev 期 vite 直接服务用户源文件
  '/node_modules/',
] as const;

const FRAMEWORK_SKIP_EXACT = new Set([
  '/health',
  '/metrics',
  '/sitemap.xml',
  '/robots.txt',
  '/favicon.ico',
]);

// 跟 defaults/runtime/request.tsx 保持一致 —— RSC client navigation 用这个后缀
const RSC_POSTFIX = '_.rsc';

export function createLocaleRedirectMiddleware(
  options: CreateLocaleRedirectOptions
): ((req: Request, res: Response, next: NextFunction) => void) | null {
  const { i18n, skipPathPrefixes = [] } = options;
  // prefixDefault=false 时所有 locale 包括默认都允许裸 URL（'/about' 是默认 locale），
  // 不需要 redirect；返回 null 让上层不挂中间件。
  if (!i18n.prefixDefault) return null;
  if (!i18n.locales || i18n.locales.length === 0) return null;

  const localeSet = new Set(i18n.locales);

  return function localeRedirectMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rawPath = req.path;

    if (FRAMEWORK_SKIP_EXACT.has(rawPath)) return next();
    for (const p of FRAMEWORK_SKIP_PREFIXES) if (rawPath.startsWith(p)) return next();
    for (const p of skipPathPrefixes) if (rawPath.startsWith(p)) return next();

    // RSC client navigation 用 `_.rsc` 后缀（详见 defaults/runtime/request.tsx）。
    // 这是 engine 自有的"逻辑路由后缀"，不是真静态资源 —— 必须跟 HTML 请求走同
    // 一套 redirect 规则，不然客户端导航 pushState('/') 拉到的 RSC 永远不带 locale
    // 前缀，URL 永远跟 /zh-CN 不同步。剥后缀做路由判定，redirect 目标拼回去。
    let path = rawPath;
    let rscSuffix = '';
    if (path.endsWith(RSC_POSTFIX)) {
      rscSuffix = RSC_POSTFIX;
      path = path.slice(0, -RSC_POSTFIX.length) || '/';
    }

    // 真静态资源（含点号判定 —— /assets/foo.css、/logo.svg、/manifest.webmanifest）
    // 注意：这一步在剥 _.rsc 之后；rsc 后缀已经去掉，剩下的点号才是真资源。
    if (path.includes('.')) return next();

    // 已带合法 locale 前缀就放行（对 BCP 47 大小写不敏感：/zh-cn/books → /zh-CN/books 也走这里）
    const first = path.split('/')[1];
    if (first) {
      if (localeSet.has(first)) return next();
      const ci = i18n.locales.find(l => l.toLowerCase() === first.toLowerCase());
      if (ci) {
        const rest = path.slice(first.length + 1) || '/';
        const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const finalRest = rest === '/' ? '' : rest;
        res.redirect(308, `/${ci}${finalRest}${rscSuffix}${search}`);
        return;
      }
    }

    // 决议目标 locale：cookie 'locale' → Accept-Language → defaultLocale
    const cookieHeader = typeof req.headers['cookie'] === 'string' ? req.headers['cookie'] : '';
    const cookieLocale = readCookieLocale(cookieHeader);
    const target =
      (cookieLocale && localeSet.has(cookieLocale) ? cookieLocale : null) ||
      negotiateLocale(
        typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : null,
        i18n
      );

    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, withLocale(path, target, i18n) + rscSuffix + search);
  };
}

function readCookieLocale(header: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() === 'locale') {
      try {
        return decodeURIComponent(trimmed.slice(eq + 1).trim());
      } catch {
        return trimmed.slice(eq + 1).trim();
      }
    }
  }
  return null;
}
