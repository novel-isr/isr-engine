import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectClientReferenceDependencies } from '../createIsrPlugin';

const fixtureRoots: string[] = [];

describe('detectClientReferenceDependencies', () => {
  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    );
  });

  it('detects package entrypoints that declare use client', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-client-reference-deps-'));
    fixtureRoots.push(root);

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          private: true,
          dependencies: {
            'client-pkg': '1.0.0',
            'server-pkg': '1.0.0',
          },
        },
        null,
        2
      )
    );

    await createPackage(root, 'client-pkg', `'use client';\nexport const Button = () => null;\n`);
    await createPackage(root, 'server-pkg', `export const value = 1;\n`);

    expect(detectClientReferenceDependencies(root)).toEqual(['client-pkg']);
  });
});

async function createPackage(root: string, name: string, source: string): Promise<void> {
  const dir = path.join(root, 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: './index.js' }));
  await writeFile(path.join(dir, 'index.js'), source);
}
