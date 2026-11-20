import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const reactWithStyleHintFix = '19.3.1';

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('stylesheet lifecycle ownership', () => {
  it('delegates Flight and DOM stylesheet resources to React', () => {
    const clientEntry = source('src/defaults/runtime/defineClientEntry.tsx');
    const serverEntry = source('src/defaults/runtime/defineServerEntry.tsx');
    const ssrEntry = source('src/defaults/entry.server.ssr.tsx');

    expect(clientEntry).not.toContain('installClientPreloadHintFix');
    expect(serverEntry).not.toContain('stripRscCssPreloadHints');
    expect(ssrEntry).not.toContain('standardizePreloadHints');
  });

  it('pins one React build that emits CSS Flight hints with as=style', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const dependency of ['react', 'react-dom']) {
      expect(packageJson.peerDependencies[dependency]).toBe(reactWithStyleHintFix);
      expect(packageJson.devDependencies[dependency]).toBe(reactWithStyleHintFix);
    }
    expect(packageJson.dependencies).not.toHaveProperty('react-server-dom-webpack');
    expect(packageJson.dependencies).not.toHaveProperty('webpack');
    expect(packageJson.dependencies['rsc-html-stream']).toMatch(/^0\.0\.\d+$/);
    expect(packageJson.peerDependencies).not.toHaveProperty('react-server-dom-webpack');
    expect(packageJson.peerDependencies).not.toHaveProperty('rsc-html-stream');
    expect(packageJson.dependencies['@vitejs/plugin-rsc']).toBe('0.5.39');
    const pluginDir = dirname(
      createRequire(import.meta.url).resolve('@vitejs/plugin-rsc/package.json')
    );
    const flightManifest = JSON.parse(
      readFileSync(resolve(pluginDir, 'dist/vendor/react-server-dom/package.json'), 'utf8')
    );
    expect(flightManifest.version).toBe(reactWithStyleHintFix);
  });

  it('uses the declared exact Vite peer in the workspace and runnable apps', () => {
    const packageJson = JSON.parse(source('package.json'));
    expect(packageJson.peerDependencies.vite).toMatch(/^\d+\.\d+\.\d+$/);
    for (const manifest of [
      'package.json',
      'bench/app/package.json',
      'e2e/dev-css-lifecycle/package.json',
      'e2e/production/package.json',
      'examples/hello-world/package.json',
    ]) {
      expect(JSON.parse(source(manifest)).devDependencies.vite, manifest).toBe(
        packageJson.peerDependencies.vite
      );
    }
  });

  it('carries each development generation into an engine-owned React commit boundary', () => {
    const clientEntry = source('src/defaults/runtime/defineClientEntry.tsx');
    const serverEntry = source('src/defaults/runtime/defineServerEntry.tsx');
    const commitBoundary = source('src/defaults/runtime/dev-style-commit-boundary.client.tsx');
    const pluginRscBoundary = source('src/defaults/runtime/dev-css-handoff.client.ts');
    const registry = source('src/defaults/runtime/dev-style-registry.client.ts');
    const responseObserver = source('src/defaults/runtime/dev-rsc-response.client.ts');
    const resourceDispatcher = source(
      'src/defaults/runtime/dev-style-resource-dispatcher.server.ts'
    );
    const declarations = source('src/defaults/runtime/dev-style-declarations.server.ts');
    const plugin = source('src/plugin/createDevCssHandoffPlugin.ts');
    const request = source('src/defaults/runtime/request.tsx');

    expect(clientEntry).toContain('DevStyleCommitBoundary');
    expect(clientEntry).not.toContain('devStyleIds');
    expect(serverEntry).not.toContain('devStyleIds');
    expect(serverEntry).toContain('onClientReference');
    expect(clientEntry).toContain('observeDevRscResponse');
    expect(clientEntry).toContain('getOrCreateDevStyleRegistry');
    expect(responseObserver).toContain('queueMicrotask(resolveCompletion)');
    expect(responseObserver).toContain('void completed.catch(() => {})');
    expect(resourceDispatcher).toContain("'vite-rsc/client-reference'");
    expect(resourceDispatcher).toContain('media === undefined ? undefined : { media }');
    expect(declarations).toContain("generation === undefined ? undefined : 'not all'");
    expect(declarations).toContain('createDevStyleStylesheetHref(styleId)');
    expect(plugin).toContain('assertPinnedDevStyleResourceDispatcher();');
    expect(clientEntry).toContain('devStyleGeneration: generation');
    expect(serverEntry).toContain('transportGeneration: renderRequest.devStyleGeneration');
    expect(request).toContain(
      'if (import.meta.env.DEV && options.devStyleGeneration !== undefined)'
    );
    expect(request).toContain('if (import.meta.env.DEV && encodedGeneration !== null)');
    expect(commitBoundary).toContain('commitDevStyleTree(generation, styleIds)');
    expect(pluginRscBoundary).not.toContain('reconcileDocumentStyles');
    expect(registry).toContain('const bootstrapLinks = new Map');
    expect(registry).toContain('generationLinks(generation)');
  });
});
