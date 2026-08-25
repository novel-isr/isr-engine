import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const reactWithStyleHintFix = '19.3.0-canary-bd6ea412-20260824';

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
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const dependency of ['react', 'react-dom', 'react-server-dom-webpack']) {
      expect(packageJson.peerDependencies[dependency]).toBe(reactWithStyleHintFix);
      expect(packageJson.devDependencies[dependency]).toBe(reactWithStyleHintFix);
    }
  });

  it('carries each development generation into an engine-owned React commit boundary', () => {
    const clientEntry = source('src/defaults/runtime/defineClientEntry.tsx');
    const commitBoundary = source('src/defaults/runtime/dev-style-commit-boundary.client.tsx');
    const pluginRscBoundary = source('src/defaults/runtime/dev-css-handoff.client.ts');

    expect(clientEntry).toContain('DevStyleCommitBoundary');
    expect(clientEntry).toContain('generation');
    expect(commitBoundary).toContain('commitDevStyleTree(generation)');
    expect(pluginRscBoundary).not.toContain('reconcileDocumentStyles');
  });
});
