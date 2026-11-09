import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

export const STATIC_CSP_MANIFEST = 'static-csp-manifest.json';
const SCHEMA_VERSION = 2;

interface StaticCspFile {
  path: string;
  sha256: string;
  scriptHashes: string[];
}
export interface StaticCspManifest {
  schemaVersion: number;
  buildId: string;
  deploymentFiles: Array<{ path: string; sha256: string }>;
  files: StaticCspFile[];
}
export interface StaticCspIndex {
  legacy: boolean;
  buildId: string;
  scriptHashes: ReadonlyMap<string, readonly string[]>;
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** parse5 follows browser tokenization, including raw script text and inert templates. */
export function collectInlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if (
      'tagName' in node &&
      node.tagName === 'script' &&
      !node.attrs.some(attr => attr.name === 'src')
    ) {
      const text = node.childNodes.map(child => ('value' in child ? child.value : '')).join('');
      hashes.add(`'sha256-${createHash('sha256').update(text).digest('base64')}'`);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
    // Template contents are a separate document fragment, never active script children.
  }
  visit(parse(html));
  return [...hashes].sort();
}

export function applyStaticScriptPolicy(policy: string, hashes: readonly string[]): string {
  const directives = policy.split(';').filter(directive => {
    const name = directive.trim().split(/\s/, 1)[0].toLowerCase();
    return name !== 'script-src' && name !== 'script-src-elem';
  });
  return [...directives, ["script-src 'self'", ...hashes].join(' ')].join(';');
}

async function readHtmlFiles(clientDir: string, parseScripts = false): Promise<StaticCspFile[]> {
  const files: StaticCspFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        const bytes = await fs.readFile(absolute);
        files.push({
          path: path.relative(clientDir, absolute).split(path.sep).join('/'),
          sha256: sha256(bytes),
          scriptHashes: parseScripts ? collectInlineScriptHashes(bytes.toString('utf8')) : [],
        });
      }
    }
  }
  await walk(clientDir);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

const CLIENT_BUILD_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.wasm',
  '.json',
  '.html',
  '.htm',
  '.svg',
]);

function isDeploymentPath(relative: string): boolean {
  if (
    relative.includes('\\') ||
    relative.split('/').some(segment => !segment || segment === '.' || segment === '..')
  )
    return false;
  return (
    relative.startsWith('rsc/') ||
    relative.startsWith('ssr/') ||
    (relative.startsWith('client/') &&
      CLIENT_BUILD_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()))
  );
}

/** Hash executable build artifacts incrementally; do not load media or source maps from client/. */
async function readDeploymentFiles(
  distDir: string
): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(distDir, absolute).split(path.sep).join('/');
        if (!isDeploymentPath(relative)) continue;
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) digest.update(chunk);
        files.push({ path: relative, sha256: digest.digest('hex') });
      }
    }
  }
  for (const directory of ['rsc', 'ssr', 'client']) {
    try {
      await walk(path.join(distDir, directory));
    } catch (error) {
      // Custom Fetch builds may not emit a separate SSR environment.
      if (directory !== 'ssr' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function manifestPayload(manifest: Omit<StaticCspManifest, 'buildId'>): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    deploymentFiles: manifest.deploymentFiles.map(file => ({
      path: file.path,
      sha256: file.sha256,
    })),
    files: manifest.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      scriptHashes: file.scriptHashes,
    })),
  });
}

async function createManifest(distDir: string): Promise<StaticCspManifest> {
  await fs.access(path.join(distDir, 'rsc/index.js'));
  const deploymentFiles = await readDeploymentFiles(distDir);
  const files = await readHtmlFiles(path.join(distDir, 'client'), true);
  const payload = { schemaVersion: SCHEMA_VERSION, deploymentFiles, files };
  return { ...payload, buildId: sha256(manifestPayload(payload)) };
}

/** Called only after every build environment, SSG output and SPA shell are complete. */
export async function generateStaticCspManifest(distDir: string): Promise<StaticCspManifest> {
  const manifest = await createManifest(distDir);
  const destination = path.join(distDir, STATIC_CSP_MANIFEST);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return manifest;
}

function validateManifest(value: unknown): asserts value is StaticCspManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid static CSP manifest');
  const manifest = value as Partial<StaticCspManifest>;
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    throw new Error('Unsupported static CSP manifest schema');
  const digest = /^[a-f0-9]{64}$/;
  if (
    !Array.isArray(manifest.deploymentFiles) ||
    typeof manifest.buildId !== 'string' ||
    !digest.test(manifest.buildId) ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Invalid static CSP manifest fields');
  let previous = '';
  for (const file of manifest.deploymentFiles) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      file.path <= previous ||
      !isDeploymentPath(file.path) ||
      typeof file.sha256 !== 'string' ||
      !digest.test(file.sha256)
    )
      throw new Error('Invalid static CSP manifest deployment entry');
    previous = file.path;
  }
  if (!manifest.deploymentFiles.some(file => file.path === 'rsc/index.js'))
    throw new Error('Static CSP manifest is missing the RSC build');
  previous = '';
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      file.path <= previous ||
      file.path.includes('\\') ||
      file.path.startsWith('/') ||
      file.path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
      !file.path.toLowerCase().endsWith('.html') ||
      typeof file.sha256 !== 'string' ||
      !digest.test(file.sha256) ||
      !Array.isArray(file.scriptHashes) ||
      !file.scriptHashes.every(
        hash => typeof hash === 'string' && /^'sha256-[A-Za-z0-9+/]{43}='$/.test(hash)
      )
    )
      throw new Error('Invalid static CSP manifest file entry');
    previous = file.path;
  }
  if (sha256(manifestPayload(manifest as StaticCspManifest)) !== manifest.buildId)
    throw new Error('Static CSP manifest integrity mismatch');
}

/** Missing manifests are legacy builds; present but invalid manifests always stop startup. */
export async function loadStaticCspManifest(
  distDir: string,
  options: { onLegacyBuild?: () => void } = {}
): Promise<StaticCspIndex> {
  let serialized: string;
  try {
    serialized = await fs.readFile(path.join(distDir, STATIC_CSP_MANIFEST), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const manifest = await createManifest(distDir);
    options.onLegacyBuild?.();
    return indexManifest(manifest, true);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(serialized);
  } catch (error) {
    throw new Error('Invalid static CSP manifest JSON', { cause: error });
  }
  validateManifest(manifest);
  const deployed = await readDeploymentFiles(distDir);
  if (JSON.stringify(deployed) !== JSON.stringify(manifest.deploymentFiles))
    throw new Error('Static CSP manifest does not match the deployment build');
  const actual = await readHtmlFiles(path.join(distDir, 'client'));
  if (
    actual.length !== manifest.files.length ||
    actual.some(
      (file, index) =>
        file.path !== manifest.files[index].path || file.sha256 !== manifest.files[index].sha256
    )
  )
    throw new Error('Static CSP manifest does not match deployed HTML files');
  return indexManifest(manifest, false);
}

function indexManifest(manifest: StaticCspManifest, legacy: boolean): StaticCspIndex {
  return {
    legacy,
    buildId: manifest.buildId,
    scriptHashes: new Map(
      manifest.files.map(file => [file.path, Object.freeze([...file.scriptHashes])])
    ),
  };
}
