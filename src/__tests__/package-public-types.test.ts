import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import ts from 'typescript';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it('generates auto-observability declarations from implementation and compiles a public consumer', async () => {
  const root = process.cwd();
  const source = path.join(root, 'src/defaults/auto-observability.ts');
  const configPath = path.join(root, 'tsconfig.build.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.fileNames).toContain(source);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-public-types-'));
  temporary.push(dir);
  const outDir = path.join(dir, 'declarations');
  const program = ts.createProgram([source], { ...parsed.options, outDir });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  expect(program.emit().emitSkipped).toBe(false);

  const staged = path.join(dir, 'node_modules/@novel-isr/engine');
  await fs.mkdir(staged, { recursive: true });
  await fs.copyFile(
    path.join(outDir, 'defaults/auto-observability.d.ts'),
    path.join(staged, 'auto.d.ts')
  );
  await fs.writeFile(
    path.join(staged, 'package.json'),
    JSON.stringify({
      name: '@novel-isr/engine',
      type: 'module',
      exports: { './auto-observability': { types: './auto.d.ts' } },
    })
  );
  const consumer = path.join(dir, 'consumer.ts');
  await fs.writeFile(
    consumer,
    `
    import { createAutoServerHooks, composeAutoServerHooks, resolveSentryDsnFromEnv,
      type AutoServerHooks, type AutoServerCtx } from '@novel-isr/engine/auto-observability';
    const factory: () => Promise<AutoServerHooks> = createAutoServerHooks;
    const ctx: AutoServerCtx = { traceId: 'trace', startedAt: 1 };
    const hooks: AutoServerHooks = composeAutoServerHooks([{ onResponse(response, context) {
      const status: number = response.status;
      const trace: string = context.traceId;
      void [status, trace];
    } }]);
    const dsn: string | undefined = resolveSentryDsnFromEnv({ SENTRY_ENABLED: 'true' });
    // @ts-expect-error public context timestamps must be numbers
    const invalid: AutoServerCtx = { traceId: 'trace', startedAt: 'yesterday' };
    void [factory, ctx, hooks, dsn, invalid];
  `
  );
  const check = ts.createProgram([consumer], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  expect(
    ts.getPreEmitDiagnostics(check).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  ).toEqual([]);
}, 30_000);
