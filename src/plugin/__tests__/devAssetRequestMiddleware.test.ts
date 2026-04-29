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

function installMiddleware(root: string): Connect.NextHandleFunction {
  const plugin = createDevAssetRequestMiddleware(root);
  const handlers: Connect.NextHandleFunction[] = [];
  const configureServer = plugin.configureServer;
  if (typeof configureServer !== 'function') {
    throw new Error('configureServer hook was not installed');
  }

  configureServer.call(
    {} as never,
    {
      config: { root },
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
