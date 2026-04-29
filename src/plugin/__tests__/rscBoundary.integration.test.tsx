import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtureRoots: string[] = [];
const execFileAsync = promisify(execFile);

describe('RSC client boundary integration', () => {
  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    );
  });

  it('allows a Server Component page to import an explicit use-client component', async () => {
    const root = await createFixture({
      'src/app.tsx': `
        import ClientCounter from './ClientCounter';

        export function App({ url }: { url: URL }) {
          return (
            <html>
              <body>
                <main>
                  <h1>Boundary OK</h1>
                  <ClientCounter label={url.pathname} />
                </main>
              </body>
            </html>
          );
        }
      `,
      'src/ClientCounter.tsx': `
        'use client';

        import { useState } from 'react';

        export default function ClientCounter({ label }: { label: string }) {
          const [count, setCount] = useState(0);
          return (
            <button type="button" onClick={() => setCount(value => value + 1)}>
              client boundary {label} {count}
            </button>
          );
        }
      `,
    });

    const handler = await loadBuiltRscHandler(root);
    const response = await handler.fetch(new Request('http://fixture.test/'));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-render-strategy')).toBe('rsc-ssr');
    expect(response.headers.get('x-fallback-used')).toBe('false');
    expect(html).toContain('Boundary OK');
    expect(stripReactComments(html)).toContain('client boundary / 0');
  });

  it('fails deterministically when a Server Component passes a function prop to a Client Component', async () => {
    const root = await createFixture({
      'src/app.tsx': `
        import ClientButton from './ClientButton';

        export function App() {
          return (
            <html>
              <body>
                <ClientButton onClick={() => 'server function'} />
              </body>
            </html>
          );
        }
      `,
      'src/ClientButton.tsx': `
        'use client';

        export default function ClientButton({ onClick }: { onClick: () => string }) {
          return <button type="button" onClick={onClick}>invalid boundary</button>;
        }
      `,
    });

    const handler = await loadBuiltRscHandler(root);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let response!: Response;
    let rscPayload!: string;
    try {
      response = await handler.fetch(new Request('http://fixture.test/_.rsc'));
      rscPayload = await response.text();
    } finally {
      consoleError.mockRestore();
    }

    expect(response.headers.get('content-type')).toContain('text/x-component');
    expect(rscPayload).toMatch(
      /Event handlers cannot be passed to Client Component props|Functions cannot be passed directly to Client Components/
    );
    expect(rscPayload).toContain('onClick');
  });
});

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-rsc-boundary-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2)
  );
  await writeFile(
    path.join(root, 'src/entry.rsc.tsx'),
    `
      import { renderToReadableStream } from '@vitejs/plugin-rsc/rsc';
      import { App } from './app';

      export default {
        async fetch(request: Request) {
          const url = new URL(request.url);
          const rscStream = renderToReadableStream({ root: <App url={url} /> });

          if (url.pathname.endsWith('_.rsc')) {
            return new Response(rscStream, {
              headers: { 'content-type': 'text/x-component;charset=utf-8' },
            });
          }

          const ssr = await import.meta.viteRsc.loadModule<{
            renderHTML(stream: ReadableStream<Uint8Array>): Promise<string>;
          }>('ssr', 'index');
          const html = await ssr.renderHTML(rscStream);
          return new Response(html, {
            headers: {
              'content-type': 'text/html;charset=utf-8',
              'x-render-strategy': 'rsc-ssr',
              'x-fallback-used': 'false',
            },
          });
        },
      };
    `
  );
  await writeFile(
    path.join(root, 'src/entry.ssr.tsx'),
    `
      import { createFromReadableStream } from '@vitejs/plugin-rsc/ssr';
      import * as React from 'react';
      import { renderToReadableStream } from 'react-dom/server.edge';

      interface Payload {
        root: React.ReactNode;
      }

      export async function renderHTML(rscStream: ReadableStream<Uint8Array>): Promise<string> {
        let payload: Promise<Payload> | undefined;

        function Root() {
          payload ??= createFromReadableStream<Payload>(rscStream);
          const data = React.use(payload);
          return data.root;
        }

        const htmlStream = await renderToReadableStream(<Root />);
        return await new Response(htmlStream).text();
      }
    `
  );
  await writeFile(
    path.join(root, 'src/entry.browser.tsx'),
    `
      export {};
    `
  );
  await writeFile(
    path.join(root, 'vite.config.ts'),
    `
      import { defineConfig } from 'vite';
      import rsc from '@vitejs/plugin-rsc';

      export default defineConfig({
        plugins: [rsc()],
        environments: {
          rsc: {
            build: {
              rollupOptions: {
                input: { index: './src/entry.rsc.tsx' },
              },
            },
          },
          ssr: {
            build: {
              rollupOptions: {
                input: { index: './src/entry.ssr.tsx' },
              },
            },
          },
          client: {
            build: {
              rollupOptions: {
                input: { index: './src/entry.browser.tsx' },
              },
            },
          },
        },
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          minify: false,
          sourcemap: false,
        },
      });
    `
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  const viteBin = path.join(process.cwd(), 'node_modules/.bin/vite');
  await execFileAsync(viteBin, ['build', '--config', 'vite.config.ts'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 8,
  });

  return root;
}

async function loadBuiltRscHandler(root: string): Promise<{
  fetch(request: Request): Promise<Response>;
}> {
  const url = pathToFileURL(path.join(root, 'dist/rsc/index.js'));
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  const mod = (await import(url.href)) as {
    default: { fetch(request: Request): Promise<Response> };
  };
  return mod.default;
}

function stripReactComments(html: string): string {
  return html.replace(/<!-- -->/g, '');
}
