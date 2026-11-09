import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('emits public Worker APIs that accept named binding interfaces without losing field types', async () => {
  const root = process.cwd();
  const config = ts.readConfigFile(path.join(root, 'tsconfig.build.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-types-'));
  try {
    const program = ts.createProgram(
      [
        path.join(root, 'src/adapters/runtime/cloudflare.ts'),
        path.join(root, 'src/runtime/edge-context.ts'),
      ],
      { ...parsed.options, outDir: path.join(dir, 'declarations'), emitDeclarationOnly: true }
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    ).toEqual([]);
    expect(program.emit().emitSkipped).toBe(false);
    const consumer = path.join(dir, 'consumer.ts');
    await fs.writeFile(
      consumer,
      `
      import { toCloudflareWorker, type CloudflareWorker } from './declarations/adapters/runtime/cloudflare';
      import { getEdgeContext, type EdgeContext } from './declarations/runtime/edge-context';
      interface Bindings { API_URL: string; ASSETS: { fetch(request: Request): Promise<Response> }; }
      const worker: CloudflareWorker<Bindings> = toCloudflareWorker<Bindings>({
        async fetch(request, supplied) {
          const context: EdgeContext<Bindings> | undefined = getEdgeContext<Bindings>(request);
          const endpoint: string | undefined = supplied?.env.API_URL;
          // @ts-expect-error bindings retain exact field types
          supplied?.env.API_URL.toFixed();
          void [context, endpoint];
          return new Response('ok');
        },
      }, { beforeFetch(request, env) { const endpoint: string = env.API_URL; void [request, endpoint]; } });
      declare const env: Bindings;
      const synchronous = toCloudflareWorker<Bindings>({ fetch(_request, context) { return new Response(context?.env.API_URL); } });
      worker.fetch(new Request('https://consumer.test'), env, { waitUntil() {}, passThroughOnException() {} });
      // @ts-expect-error primitive values cannot be a bindings object
      getEdgeContext<string>(new Request('https://consumer.test'));
      void [worker, synchronous];
    `
    );
    const check = ts.createProgram([consumer], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    expect(
      ts.getPreEmitDiagnostics(check).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    ).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 30_000);
