import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const CACHE_SUFFIX_MARKERS = ['$$cache=', '%24%24cache='] as const;

const DEV_ASSET_EXT_RE =
  /\.(js|mjs|cjs|ts|tsx|jsx|json|map|css|scss|sass|less|stylus|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|mp3|mp4|webm|ogg|wasm|zip|pdf)$/i;

/**
 * plugin-rsc puts a `$$cache=<id>` suffix into client reference module ids.
 * Browser requests must go back to the real source URL before Vite's transform
 * middleware sees them; otherwise `/src/Foo.tsx$$cache=...` falls through to
 * the RSC page renderer and returns HTML to a module script request.
 */
export function stripRscClientReferenceCacheSuffix(url: string): string {
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : url.slice(queryIndex);
  let markerIndex = -1;

  for (const marker of CACHE_SUFFIX_MARKERS) {
    const index = pathname.indexOf(marker);
    if (index >= 0 && (markerIndex === -1 || index < markerIndex)) {
      markerIndex = index;
    }
  }

  if (markerIndex === -1) return url;
  return `${pathname.slice(0, markerIndex)}${search}`;
}

export function createDevAssetRequestMiddleware(root: string): Plugin {
  return {
    name: 'isr:dev-asset-request-middleware',
    enforce: 'pre',
    configureServer(server) {
      const projectRoot = server.config.root || root;

      server.middlewares.use((req, res, next) => {
        const originalUrl = req.url ?? '';
        const normalizedUrl = stripRscClientReferenceCacheSuffix(originalUrl);
        if (normalizedUrl !== originalUrl) {
          req.url = normalizedUrl;
        }

        const pathname = getPathname(req.url ?? '');
        if (pathname && isDevAssetPath(pathname) && !assetExists(projectRoot, pathname)) {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`Dev asset not found: ${pathname}`);
          return;
        }

        next();
      });
    },
  };
}

function getPathname(url: string): string {
  const queryIndex = url.indexOf('?');
  const raw = queryIndex === -1 ? url : url.slice(0, queryIndex);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isDevAssetPath(pathname: string): boolean {
  return (
    (pathname.startsWith('/src/') ||
      pathname.startsWith('/node_modules/') ||
      pathname.startsWith('/@fs/')) &&
    DEV_ASSET_EXT_RE.test(pathname)
  );
}

function assetExists(root: string, pathname: string): boolean {
  const absolutePath = pathname.startsWith('/@fs/')
    ? pathname.slice('/@fs'.length)
    : path.join(root, pathname);

  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
}
