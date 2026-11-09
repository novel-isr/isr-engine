import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  generateStaticCspManifest,
  loadStaticCspManifest,
  collectInlineScriptHashes,
  applyStaticScriptPolicy,
  STATIC_CSP_MANIFEST,
} from '../staticCspManifest';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp('/tmp/isr-csp-manifest-');
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'rsc'), { recursive: true });
  await fs.mkdir(path.join(dir, 'client/static'), { recursive: true });
  await fs.writeFile(path.join(dir, 'rsc/index.js'), 'export default {fetch(){}}');
  await fs.writeFile(path.join(dir, 'client/static/index.html'), '<script>hello()</script>');
  return dir;
}
const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

it('uses the HTML parser tree, ignoring script lookalikes in comments, attributes and inert templates', () => {
  const html = `<!-- <script>comment()</script> --><div title='<script>attribute()</script>'></div><template><script>template()</script></template><SCRIPT title=">">one\r\ntwo</SCRIPT><script src="/app.js"></script><script type="importmap">{"imports":{}}</script>`;
  expect(collectInlineScriptHashes(html)).toEqual(
    [hash('one\ntwo'), hash('{"imports":{}}')].sort()
  );
});

it('generates a deterministic build-bound manifest for every client HTML after SSG and SPA work', async () => {
  const dir = await fixture();
  await fs.writeFile(path.join(dir, 'client/custom.html'), '<script>custom()</script>');
  const first = await generateStaticCspManifest(dir);
  const second = await generateStaticCspManifest(dir);
  expect(first.buildId).toBe(second.buildId);
  expect(first.files.map(file => file.path)).toEqual(['custom.html', 'static/index.html']);
  const loaded = await loadStaticCspManifest(dir);
  expect(loaded.legacy).toBe(false);
  expect(loaded.scriptHashes.get('static/index.html')).toEqual([hash('hello()')]);
  await fs.writeFile(path.join(dir, 'rsc/index.js'), 'new build');
  await expect(loadStaticCspManifest(dir)).rejects.toThrow(/build|RSC/i);
});

it.each(['changed', 'added', 'removed'])(
  'rejects a %s HTML file instead of using a stale CSP',
  async change => {
    const dir = await fixture();
    await generateStaticCspManifest(dir);
    if (change === 'changed')
      await fs.writeFile(path.join(dir, 'client/static/index.html'), '<script>changed()</script>');
    if (change === 'added')
      await fs.writeFile(path.join(dir, 'client/new.html'), '<script>newPage()</script>');
    if (change === 'removed') await fs.unlink(path.join(dir, 'client/static/index.html'));
    await expect(loadStaticCspManifest(dir)).rejects.toThrow(/HTML|manifest/i);
  }
);

it.each(['invalid-json', 'unknown-schema', 'damaged-policy'])(
  'fails closed for %s manifests',
  async damage => {
    const dir = await fixture();
    const manifest = await generateStaticCspManifest(dir);
    const corrupt =
      damage === 'invalid-json'
        ? '{'
        : JSON.stringify(
            damage === 'unknown-schema'
              ? { ...manifest, schemaVersion: 999 }
              : { ...manifest, files: [{ ...manifest.files[0], scriptHashes: [hash('evil()')] }] }
          );
    await fs.writeFile(path.join(dir, STATIC_CSP_MANIFEST), corrupt);
    const onLegacyBuild = vi.fn();
    await expect(loadStaticCspManifest(dir, { onLegacyBuild })).rejects.toThrow(
      /manifest|schema|integrity/i
    );
    expect(onLegacyBuild).not.toHaveBeenCalled();
  }
);

it('supports custom historical builds by generating a warned startup-only in-memory index', async () => {
  const dir = await fixture();
  const onLegacyBuild = vi.fn();
  const loaded = await loadStaticCspManifest(dir, { onLegacyBuild });
  expect(loaded.legacy).toBe(true);
  expect(loaded.scriptHashes.get('static/index.html')).toEqual([hash('hello()')]);
  expect(onLegacyBuild).toHaveBeenCalledOnce();
  await expect(fs.access(path.join(dir, STATIC_CSP_MANIFEST))).rejects.toThrow();
});

it('replaces script directives with verified hashes while preserving other security directives', () => {
  const policy = applyStaticScriptPolicy(
    "default-src 'self';script-src 'nonce-dynamic' 'strict-dynamic' 'unsafe-inline';script-src-elem 'unsafe-inline';connect-src 'self' https://api.example",
    [hash('hello()')]
  );
  expect(policy).toContain(`script-src 'self' ${hash('hello()')}`);
  expect(policy).not.toMatch(/nonce-|strict-dynamic|unsafe-inline|script-src-elem/);
  expect(policy).toContain("connect-src 'self' https://api.example");
});

it('does not downgrade unreadable manifests into legacy compatibility mode', async () => {
  const dir = await fixture();
  await fs.mkdir(path.join(dir, STATIC_CSP_MANIFEST));
  const onLegacyBuild = vi.fn();
  await expect(loadStaticCspManifest(dir, { onLegacyBuild })).rejects.toThrow();
  expect(onLegacyBuild).not.toHaveBeenCalled();
});

it('supports an SSR-only build with no static HTML', async () => {
  const dir = await fixture();
  await fs.unlink(path.join(dir, 'client/static/index.html'));
  const manifest = await generateStaticCspManifest(dir);
  expect(manifest.files).toEqual([]);
  expect((await loadStaticCspManifest(dir)).scriptHashes.size).toBe(0);
});

it('does not publish a CSP manifest when the required RSC build is missing', async () => {
  const dir = await fixture();
  await fs.unlink(path.join(dir, 'rsc/index.js'));
  await expect(generateStaticCspManifest(dir)).rejects.toThrow();
  await expect(fs.access(path.join(dir, STATIC_CSP_MANIFEST))).rejects.toThrow();
});

it.each([
  'rsc/__vite_rsc_assets_manifest.js',
  'ssr/index.js',
  'client/assets/browser.js',
  'client/assets/styles.css',
])(
  'rejects deployment drift at %s even when SSR-only index.js and all HTML stay unchanged',
  async file => {
    const dir = await fixture();
    await fs.unlink(path.join(dir, 'client/static/index.html'));
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'first build');
    const before = await generateStaticCspManifest(dir);
    await fs.writeFile(target, 'second build');
    await expect(loadStaticCspManifest(dir)).rejects.toThrow(/build|deployment/i);
    const after = await generateStaticCspManifest(dir);
    expect(after.buildId).not.toBe(before.buildId);
  }
);

it('binds build generation timestamps to the manifest and ignores deployment copy mtimes', async () => {
  const dir = await fixture();
  const html = path.join(dir, 'client/static/index.html');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(html, old, old);
  const manifest = await generateStaticCspManifest(dir);
  const generatedAt = manifest.files[0].generatedAt;
  await fs.utimes(html, new Date(), new Date());
  expect((await loadStaticCspManifest(dir)).generatedAt?.get('static/index.html')).toBe(
    generatedAt
  );
  manifest.files[0].generatedAt! += 1000;
  await fs.writeFile(path.join(dir, STATIC_CSP_MANIFEST), JSON.stringify(manifest));
  await expect(loadStaticCspManifest(dir)).rejects.toThrow(/integrity/i);
});

it('validates schema 2 builds without making deployment timestamps eligible for seeding', async () => {
  const dir = await fixture();
  const manifest = await generateStaticCspManifest(dir);
  const payload = {
    schemaVersion: 2,
    deploymentFiles: manifest.deploymentFiles,
    files: manifest.files.map(({ path, sha256, scriptHashes }) => ({ path, sha256, scriptHashes })),
  };
  await fs.writeFile(
    path.join(dir, STATIC_CSP_MANIFEST),
    JSON.stringify({
      ...payload,
      buildId: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    })
  );
  const index = await loadStaticCspManifest(dir);
  expect(index.legacy).toBe(false);
  expect(index.generatedAt?.size).toBe(0);
  expect(index.ssgRoutes).toBeUndefined();
  expect(index.scriptHashes.get('static/index.html')).toEqual([hash('hello()')]);
});
