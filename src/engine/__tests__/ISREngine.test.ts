/**
 * ISREngine 生命周期测试
 *
 * 范围：initialize → start（ops 路由可访问）→ shutdown（释放 + 失败聚合）。
 * server 层（startAppServer / shutdownServer）替换为受控实现 —— 真 Express + 真 http.Server，
 * 但不拉起 Vite/plugin-rsc（那是 server/manager 自己职责域，有独立测试）。
 * cwd 指向临时目录，隔离 scanProject / CacheCleanup / generateSeo 的磁盘副作用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import pkg from '../../../package.json';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const serverMock = vi.hoisted(() => ({
  startAppServer: vi.fn(),
  shutdownServer: vi.fn(),
}));
vi.mock('@/server', () => serverMock);

import ISREngine from '../ISREngine';
import { SEOEngine } from '../seo';
import type { ISRConfig } from '../../types';

function baseConfig(): ISRConfig {
  return {
    renderMode: 'isr',
    revalidate: 3600,
    routes: {},
    runtime: {
      site: undefined,
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,
      telemetry: false,
    },
    server: {
      port: 0,
      host: '127.0.0.1',
      strictPort: true,
      ops: {
        authToken: undefined,
        tokenHeader: 'x-isr-admin-token',
        health: { enabled: true, public: true },
        metrics: { enabled: false, public: false },
        inventory: { enabled: false, public: false },
      },
    },
    ssg: {
      routes: [],
      concurrent: 3,
      requestTimeoutMs: 30_000,
      maxRetries: 3,
      retryBaseDelayMs: 200,
      failBuildThreshold: 0.05,
    },
  };
}

describe('ISREngine —— 生命周期', () => {
  let workdir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let httpServer: http.Server | null = null;

  beforeEach(async () => {
    workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isr-engine-test-'));
    // scanProject 默认扫描 src/pages / src/api / src/components
    await fs.promises.mkdir(path.join(workdir, 'src/pages'), { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir);

    SEOEngine.resetInstance();
    httpServer = null;
    serverMock.startAppServer.mockReset();
    serverMock.shutdownServer.mockReset();
    serverMock.startAppServer.mockImplementation(
      async (_config: ISRConfig, setup: (app: express.Express) => void) => {
        const app = express();
        setup(app);
        httpServer = http.createServer(app);
        await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve));
        const { port } = httpServer!.address() as AddressInfo;
        return {
          requestHandler: app,
          viteDevMiddleware: null,
          httpServer,
          isDev: true,
          manifest: null,
          url: `http://127.0.0.1:${port}`,
        };
      }
    );
    serverMock.shutdownServer.mockImplementation(async () => {
      if (!httpServer) return;
      await new Promise<void>((resolve, reject) =>
        httpServer!.close(err => (err ? reject(err) : resolve()))
      );
      httpServer = null;
    });
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    SEOEngine.resetInstance();
    await fs.promises.rm(workdir, { recursive: true, force: true });
  });

  it('start() 后 /health 可访问；shutdown 后 listener 释放', async () => {
    const engine = new ISREngine(baseConfig());
    const ctx = await engine.start();
    expect(ctx.url).toBeTruthy();
    expect(serverMock.startAppServer).toHaveBeenCalledTimes(1);

    // ops 路由真实可访问（ISRRoutes.setup 在 startAppServer 回调里执行）
    const res = await fetch(`${ctx.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      defaultRenderMode: string;
      version: string;
    };
    expect(body.status).toBe('healthy');
    expect(body.version).toBe(pkg.version);
    expect(body.defaultRenderMode).toBe('isr');

    await engine.shutdown();
    expect(serverMock.shutdownServer).toHaveBeenCalledTimes(1);

    // server 已关闭
    await expect(fetch(`${ctx.url}/health`)).rejects.toThrow();
  });

  it('shutdown() 子步骤失败 → 抛聚合错误，其余清理仍执行（allSettled 语义）', async () => {
    const engine = new ISREngine(baseConfig());
    await engine.start();

    const seoShutdownSpy = vi.spyOn(SEOEngine.prototype, 'shutdown');
    serverMock.shutdownServer.mockRejectedValueOnce(new Error('close boom'));

    await expect(engine.shutdown()).rejects.toThrow('部分失败');
    expect(seoShutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('initialize() 在空项目目录下完成；generateSeo() 写出 robots.txt 与 sitemap.xml', async () => {
    const engine = new ISREngine(baseConfig());
    await engine.initialize();
    await engine.generateSeo();

    const outDir = path.join(workdir, '.isr-hyou/ssg');
    const robots = await fs.promises.readFile(path.join(outDir, 'robots.txt'), 'utf-8');
    const sitemap = await fs.promises.readFile(path.join(outDir, 'sitemap.xml'), 'utf-8');
    expect(robots).toContain('User-agent');
    expect(sitemap).toContain('<urlset');
  });
});
