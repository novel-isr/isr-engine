import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-package-check-'));
try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const [pack] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--dry-run',
        '--json',
        '--ignore-scripts',
        '--cache',
        path.join(temporary, 'npm-cache'),
      ],
      { cwd: root, encoding: 'utf8' }
    )
  );
  const files = new Set(pack.files.map(file => file.path));
  const targets = new Set();
  function collect(value) {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(pkg.exports);
  collect(pkg.bin);
  for (const field of ['main', 'module', 'types']) collect(pkg[field]);
  const missing = [...targets].filter(target => !files.has(target));
  if (missing.length)
    throw new Error(`Package targets missing from npm pack: ${missing.join(', ')}`);
  const tests = [...files].filter(file =>
    /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
  if (tests.length) throw new Error(`Test files included in npm pack: ${tests.join(', ')}`);

  const require = createRequire(path.join(root, 'package.json'));
  for (const [subpath, functions] of [
    ['.', ['createCoherentCacheStore']],
    [
      './auto-observability',
      ['createAutoServerHooks', 'composeAutoServerHooks', 'resolveSentryDsnFromEnv'],
    ],
  ]) {
    const entry = pkg.exports[subpath];
    const esm = await import(pathToFileURL(path.join(root, entry.import)).href);
    const commonjs = require(path.join(root, entry.require));
    for (const name of functions) {
      if (typeof esm[name] !== 'function' || typeof commonjs[name] !== 'function') {
        throw new Error(
          `Public runtime export ${subpath}:${name} missing from ESM or CommonJS build`
        );
      }
    }
  }

  // Resolve the real public exports from a consumer, without source paths or
  // an ambient declaration stub hiding a missing generated declaration.
  const scope = path.join(temporary, 'node_modules/@novel-isr');
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(root, path.join(scope, 'engine'), 'dir');
  const consumer = path.join(temporary, 'consumer.ts');
  await fs.writeFile(
    consumer,
    `
    import { createAutoServerHooks, composeAutoServerHooks, resolveSentryDsnFromEnv,
      type AutoServerCtx, type AutoServerHooks } from '@novel-isr/engine/auto-observability';
    import { createCoherentCacheStore, type ResponseCacheBackend } from '@novel-isr/engine';
    const factory: () => Promise<AutoServerHooks> = createAutoServerHooks;
    const ctx: AutoServerCtx = { traceId: 'trace', startedAt: 1 };
    const hooks: AutoServerHooks = composeAutoServerHooks([]);
    const dsn: string | undefined = resolveSentryDsnFromEnv({});
    declare const backend: ResponseCacheBackend;
    const store = createCoherentCacheStore({ backend });
    // @ts-expect-error timestamps are numeric in the public contract
    const invalid: AutoServerCtx = { traceId: 'trace', startedAt: 'yesterday' };
    void [factory, ctx, hooks, dsn, store, invalid];
  `
  );
  const program = ts.createProgram([consumer], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: name => name,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      })
    );
  }
  console.log(
    `Verified ${targets.size} package targets and public consumer types; ${files.size} packed files contain no tests.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
