import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { Connect, ViteDevServer } from 'vite';

import {
  createDevAssetRequestMiddleware,
  stripRscClientReferenceCacheSuffix,
} from '../devAssetRequestMiddleware';

const roots: string[] = [];

describe('dev asset request middleware', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('normalizes plugin-rsc client reference $$cache suffixes before Vite handles them', async () => {
    const root = await createRoot({
      'src/components/Header/index.tsx': 'export default function Header() { return null; }',
    });
    const handler = installMiddleware(root);
    const req = { url: '/src/components/Header/index.tsx$$cache=abc123' };
    const res = createResponse();
    let nextCalled = false;

    handler(req as Connect.IncomingMessage, res as never, () => {
      nextCalled = true;
    });

    expect(req.url).toBe('/src/components/Header/index.tsx');
    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
  });

  it('returns 404 for missing source assets instead of letting RSC render HTML', async () => {
    const root = await createRoot({});
    const handler = installMiddleware(root);
    const req = { url: '/src/runtime/boundary.module.scss' };
    const res = createResponse();
    let nextCalled = false;

    handler(req as Connect.IncomingMessage, res as never, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toContain('Dev asset not found: /src/runtime/boundary.module.scss');
  });

  it('leaves generated optimize-dependency URLs under Vite ownership', async () => {
    const root = await createRoot({});
    const cacheDir = path.join(root, 'node_modules/.vite');
    const handler = installMiddleware(root, cacheDir);
    const optimizedPaths = [
      '/node_modules/.vite/deps/rsc-html-stream_client.js?v=cold-start',
      `/@fs/${path.join(cacheDir, 'deps_rsc/react.js')}`,
      `/@fs/${path.join(cacheDir, 'deps_ssr_temp_deadbeef/react-dom.js')}`,
      `/@fs/${path.join(cacheDir, 'deps_temp_0123abcd/react.js')}`,
    ];

    for (const url of optimizedPaths) {
      const result = handleRequest(handler, url);
      expect(result.nextCalled, url).toBe(true);
      expect(result.res.ended, url).toBe(false);
    }
  });

  it('keeps missing source assets guarded when cacheDir contains the project', async () => {
    const root = await createRoot({});

    for (const cacheDir of [root, path.dirname(root)]) {
      const handler = installMiddleware(root, cacheDir);
      for (const url of [
        '/src/missing.js',
        '/node_modules/missing-package/index.js',
        `/@fs/${path.join(root, 'src/missing.js')}`,
      ]) {
        const result = handleRequest(handler, url);
        expect(result.nextCalled, `${cacheDir}: ${url}`).toBe(false);
        expect(result.res.statusCode, `${cacheDir}: ${url}`).toBe(404);
      }
    }
  });

  it('does not delegate unrelated or escaping cache paths as optimized dependencies', async () => {
    const root = await createRoot({});
    const cacheDir = path.join(root, 'node_modules/.vite');
    const handler = installMiddleware(root, cacheDir);
    const guardedPaths = [
      '/node_modules/.vite/metadata.js',
      '/node_modules/.vite/deps-other/not-vite.js',
      '/node_modules/.vite/deps_temp_not-a-vite-hash/not-vite.js',
      '/node_modules/.vite/deps/../../escaped.js',
      '/node_modules/.vite/deps/%2e%2e/%2e%2e/encoded-escape.js',
    ];

    for (const url of guardedPaths) {
      const result = handleRequest(handler, url);
      expect(result.nextCalled, url).toBe(false);
      expect(result.res.statusCode, url).toBe(404);
    }
  });

  it('keeps query strings when stripping cache suffixes', () => {
    expect(stripRscClientReferenceCacheSuffix('/src/App.tsx$$cache=abc?v=1')).toBe(
      '/src/App.tsx?v=1'
    );
    expect(stripRscClientReferenceCacheSuffix('/src/App.tsx%24%24cache=abc')).toBe('/src/App.tsx');
    expect(stripRscClientReferenceCacheSuffix('/src/App.tsx')).toBe('/src/App.tsx');
  });
});

async function createRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-dev-asset-'));
  roots.push(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  return root;
}

function installMiddleware(
  root: string,
  cacheDir = path.join(root, 'node_modules/.vite')
): Connect.NextHandleFunction {
  const plugin = createDevAssetRequestMiddleware(root);
  const handlers: Connect.NextHandleFunction[] = [];
  const configureServer = plugin.configureServer;
  if (typeof configureServer !== 'function') {
    throw new Error('configureServer hook was not installed');
  }

  configureServer.call(
    {} as never,
    {
      config: { root, cacheDir },
      middlewares: {
        use(handler: Connect.NextHandleFunction) {
          handlers.push(handler);
        },
      },
    } as unknown as ViteDevServer
  );

  const handler = handlers[0];
  if (!handler) throw new Error('middleware was not installed');
  return handler;
}

function handleRequest(
  handler: Connect.NextHandleFunction,
  url: string
): { nextCalled: boolean; res: ReturnType<typeof createResponse> } {
  const req = { url };
  const res = createResponse();
  let nextCalled = false;
  handler(req as Connect.IncomingMessage, res as never, () => {
    nextCalled = true;
  });
  return { nextCalled, res };
}

function createResponse(): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
} {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = chunk;
      this.ended = true;
    },
  };
}
