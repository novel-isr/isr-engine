import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearCaches, parseForESLint } from '@typescript-eslint/parser';

const temporary: string[] = [];

afterEach(() => {
  clearCaches();
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('preserves project-service wildcard, brace, and dotfile matching for out-of-project tooling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isr-eslint-project-service-'));
  temporary.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const value = 1;');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));

  const options = {
    tsconfigRootDir: root,
    projectService: { allowDefaultProject: ['tools/*.{ts,cts}', '*.config.ts'] },
    // Exercise the long-lived project service used by editor and CLI linting.
    disallowAutomaticSingleRunInference: true,
  };
  const code = 'export const enabled: boolean = true;';
  for (const relative of ['tools/build.ts', 'tools/check.cts', '.lint.config.ts']) {
    const filePath = path.join(root, relative);
    fs.writeFileSync(filePath, code);
    const result = parseForESLint(code, { ...options, filePath });
    expect(result.services.program?.getSourceFile(filePath)?.text).toBe(code);
  }

  // Matching must not broaden to another extension or cross a directory boundary.
  for (const relative of ['tools/check.mts', 'tools/nested/build.ts']) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, code);
    expect(() => parseForESLint(code, { ...options, filePath })).toThrow(
      /allowDefaultProject is set to .*which does not match/
    );
  }
});

it('keeps tsconfig project glob resolution and directory exclusions working', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isr-eslint-project-globs-'));
  temporary.push(root);
  const code = 'export const value: number = 1;';
  for (const name of ['app', 'ignored']) {
    const directory = path.join(root, 'packages', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.ts'), code);
    fs.writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({ include: ['index.ts'] })
    );
  }
  const options = {
    tsconfigRootDir: root,
    project: ['packages/*/tsconfig.json'],
    projectFolderIgnoreList: ['**/ignored/**'],
  };
  const filePath = path.join(root, 'packages/app/index.ts');
  expect(
    parseForESLint(code, { ...options, filePath }).services.program?.getSourceFile(filePath)?.text
  ).toBe(code);
  expect(() =>
    parseForESLint(code, {
      ...options,
      filePath: path.join(root, 'packages/ignored/index.ts'),
    })
  ).toThrow(/packages[/\\]ignored[/\\]index\.ts/);
});
