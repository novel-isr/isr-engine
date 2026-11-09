import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// See https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/
// Build the public package entries, including the shipped adapter and source runtime.
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/fixtures/workers-runtime.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  conditions: ['browser'],
  // The fixture's type-check project maps to source declarations; runtime verification
  // must resolve the real package exports instead of following those aliases.
  tsconfigRaw: { compilerOptions: { target: 'ES2022', jsx: 'react-jsx' } },
  outfile: 'worker.js',
  write: false,
  metafile: true,
});
assert(
  Object.keys(bundle.metafile.inputs).some(name => name.includes('dist/adapters/runtime/')),
  'Expected the shipped adapter export'
);
assert(
  Object.keys(bundle.metafile.inputs).some(name => name.includes('src/runtime/edge-context.ts')),
  'Expected the public source runtime export'
);
const workerBundle = bundle.outputFiles.find(file => path.basename(file.path) === 'worker.js');
assert(workerBundle, 'Missing Worker JavaScript output');
const script = workerBundle.text;

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const overlap = deferred();
const stream = deferred();
const background = deferred();
const backgroundDone = deferred();
let arrivals = 0;
const runtime = new Miniflare({
  modules: true,
  script,
  compatibilityDate: '2026-07-30',
  compatibilityFlags: [],
  cf: false,
  outboundService() {
    throw new Error('Unexpected outbound network request');
  },
  bindings: { MARKER: 'workerd-binding' },
  serviceBindings: {
    async HOST(request) {
      switch (new URL(request.url).pathname) {
        case '/before-gate':
          if (++arrivals === 2) overlap.resolve();
          await overlap.promise;
          break;
        case '/stream-gate':
          await stream.promise;
          break;
        case '/background-gate':
          await background.promise;
          break;
        case '/background-done':
          backgroundDone.resolve();
          break;
        default:
          throw new Error(`Unexpected host request: ${request.url}`);
      }
      return new Response('ok');
    },
  },
});

try {
  await bounded(runtime.ready, 'workerd startup');
  const synchronous = await bounded(
    runtime.dispatchFetch('https://worker/synchronous'),
    'synchronous handler'
  );
  assert.equal(synchronous.status, 200);
  assert.equal(await bounded(synchronous.text(), 'synchronous body'), 'workerd-binding');
  await bounded(
    Promise.all(
      ['/concurrent/a', '/concurrent/b'].map(async path => {
        const response = await runtime.dispatchFetch(`https://worker${path}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { path, marker: 'workerd-binding' });
      })
    ),
    'overlapping beforeFetch'
  );
  assert.equal(arrivals, 2);

  const streamed = await bounded(runtime.dispatchFetch('https://worker/stream'), 'stream headers');
  assert.equal(streamed.status, 200);
  stream.resolve(); // Only release the producer after fetch has returned its response.
  assert.equal(await bounded(streamed.text(), 'stream body'), 'workerd-binding');

  const scheduled = await bounded(
    runtime.dispatchFetch('https://worker/background'),
    'background response'
  );
  assert.equal(await bounded(scheduled.text(), 'background response body'), 'scheduled');
  background.resolve();
  await bounded(backgroundDone.promise, 'waitUntil completion');

  for (const path of ['/consumed', '/locked']) {
    const response = await bounded(
      runtime.dispatchFetch(`https://worker${path}`, { method: 'POST', body: 'payload' }),
      path
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await bounded(response.text(), `${path} body`), 'Internal Server Error');
  }
  console.log(
    'Official workerd: public entry identity, concurrent hooks, streaming, waitUntil and consumed/locked body errors verified.'
  );
} finally {
  overlap.resolve();
  stream.resolve();
  background.resolve();
  await bounded(runtime.dispose(), 'workerd disposal');
}
