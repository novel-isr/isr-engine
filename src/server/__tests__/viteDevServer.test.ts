import { afterEach, describe, expect, it, vi } from 'vitest';

const vite = vi.hoisted(() => ({
  createServer: vi.fn(),
  loadConfigFromFile: vi.fn(),
}));

vi.mock('vite', async importOriginal => {
  const actual = await importOriginal<typeof import('vite')>();
  return {
    ...actual,
    createServer: vite.createServer,
    loadConfigFromFile: vite.loadConfigFromFile,
  };
});

import { closeViteDevServer, createViteDevServer } from '../viteDevServer';

describe('createViteDevServer', () => {
  afterEach(async () => {
    await closeViteDevServer();
    vi.clearAllMocks();
  });

  it('does not reload a config file after loading and merging it explicitly', async () => {
    vite.loadConfigFromFile.mockResolvedValue({
      path: '/app/vite.config.ts',
      config: {
        plugins: [],
        ssr: {},
      },
      dependencies: [],
    });
    vite.createServer.mockResolvedValue({ close: vi.fn() });

    await createViteDevServer();

    expect(vite.createServer).toHaveBeenCalledOnce();
    expect(vite.createServer.mock.calls[0]?.[0]).toMatchObject({
      configFile: false,
      appType: 'custom',
      server: { middlewareMode: true },
    });
  });
});
