import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('vite', async importOriginal => {
  const actual = await importOriginal<typeof import('vite')>();
  return {
    ...actual,
    version: '8.0.15',
  };
});

import { resolveConfig } from 'vite';

import { createDevCssLifecyclePlugins } from '../createDevCssHandoffPlugin';

describe('development CSS Vite compatibility gate', () => {
  const defaultsDir = path.resolve(process.cwd(), 'src/defaults');

  it('does not apply the development Vite gate while resolving a production build', async () => {
    const plugins = createDevCssLifecyclePlugins(defaultsDir);

    await expect(
      resolveConfig(
        {
          configFile: false,
          logLevel: 'silent',
          plugins,
          root: process.cwd(),
        },
        'build'
      )
    ).resolves.toMatchObject({ command: 'build' });
  });

  it('rejects an unsupported Vite during serve config resolution before transforms', async () => {
    const plugins = createDevCssLifecyclePlugins(defaultsDir);
    const transform = vi.fn();
    plugins.push({
      name: 'fixture:transform-probe',
      apply: 'serve',
      transform,
    });

    await expect(
      resolveConfig(
        {
          configFile: false,
          logLevel: 'silent',
          plugins,
          root: process.cwd(),
        },
        'serve'
      )
    ).rejects.toThrow(/requires Vite 8\.0\.14.*detected 8\.0\.15/i);
    expect(transform).not.toHaveBeenCalled();
  });
});
