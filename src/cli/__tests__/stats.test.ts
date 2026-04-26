/**
 * CLI stats —— `novel-isr stats` 拉取运行中引擎的 `/__isr/stats` JSON
 *
 * 测试策略：起真 http.Server 模拟 /__isr/stats 返回不同响应（正常 / 非法 shape /
 * 404 / 断连），通过 `showStats({ host, port })` 直接调用 —— 既覆盖
 * resolveMetricsUrl 的 URL 拼装，也覆盖 fetchMetricsByUrl 的 payload 校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { showStats } from '../stats';
import { logger } from '../../logger';

// stats.ts 通过 loadConfig() 读取默认 server.port —— 我们用 vi.mock 让它返回最小 config
vi.mock('../../config/loadConfig', () => ({
  loadConfig: async () => ({
    renderMode: 'isr',
    cache: { strategy: 'memory', ttl: 3600 },
  }),
}));

interface MockServer {
  server: Server;
  port: number;
  /** 下一次请求的响应由这里控制 */
  handler: { current: (req: http.IncomingMessage, res: http.ServerResponse) => void };
}

async function startMockStatsServer(): Promise<MockServer> {
  const handler: MockServer['handler'] = {
    current: (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ size: 10, max: 1000, revalidating: 0, backend: 'memory' }));
    },
  };
  const server = http.createServer((req, res) => handler.current(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, handler };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve()))
  );
}

/**
 * 捕获 logger 输出 —— stats 模块用 `logger.info / logger.warn` 打印
 * 直接在 logger 单例对象上 spy，避免 require 在 ESM 下失败。
 */
function captureLogger(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const infoSpy = vi
    .spyOn(logger, 'info')
    .mockImplementation((...args: unknown[]) => void messages.push('[INFO] ' + args.join(' ')));
  const warnSpy = vi
    .spyOn(logger, 'warn')
    .mockImplementation((...args: unknown[]) => void messages.push('[WARN] ' + args.join(' ')));
  const errorSpy = vi
    .spyOn(logger, 'error')
    .mockImplementation((...args: unknown[]) => void messages.push('[ERROR] ' + args.join(' ')));
  return {
    messages,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe('showStats —— 正常快照', () => {
  let mock: MockServer;
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(async () => {
    mock = await startMockStatsServer();
    cap = captureLogger();
  });
  afterEach(async () => {
    cap.restore();
    await stopServer(mock.server);
  });

  it('拉取 /__isr/stats → 打印 size/max/backend/revalidating', async () => {
    await showStats({
      watch: false,
      detailed: false,
      host: '127.0.0.1',
      port: mock.port,
    });
    const out = cap.messages.join('\n');
    expect(out).toMatch(/ISR 缓存指标/);
    expect(out).toMatch(/缓存后端: memory/);
    expect(out).toMatch(/缓存条目: 10\/1000/);
    expect(out).toMatch(/后台重生中: 0/);
  });

  it('--detailed 额外打印 Prometheus /metrics URL', async () => {
    await showStats({
      watch: false,
      detailed: true,
      host: '127.0.0.1',
      port: mock.port,
    });
    const out = cap.messages.join('\n');
    expect(out).toMatch(/Prometheus 指标:\s*http:\/\/127\.0\.0\.1:\d+\/metrics/);
  });

  it('backend=hybrid 也被识别为合法 snapshot', async () => {
    mock.handler.current = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ size: 0, max: 100, revalidating: 5, backend: 'hybrid' }));
    };
    await showStats({
      watch: false,
      detailed: false,
      host: '127.0.0.1',
      port: mock.port,
    });
    const out = cap.messages.join('\n');
    expect(out).toMatch(/缓存后端: hybrid/);
  });

  it('port 参数接受字符串 → 被 parseInt', async () => {
    await showStats({
      watch: false,
      detailed: false,
      host: '127.0.0.1',
      port: String(mock.port),
    });
    const out = cap.messages.join('\n');
    expect(out).toMatch(/ISR 缓存指标/);
  });
});

describe('showStats —— 错误路径', () => {
  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => {
    cap = captureLogger();
  });
  afterEach(() => {
    cap.restore();
  });

  it('未配置 host → 警告不做网络请求', async () => {
    // 通过 vi.stubEnv 清掉可能存在的 env host
    vi.stubEnv('ISR_HOST', '');
    vi.stubEnv('HOST', '');
    await showStats({ watch: false, detailed: false });
    vi.unstubAllEnvs();
    const out = cap.messages.join('\n');
    expect(out).toMatch(/未配置 metrics 访问地址/);
  });

  it('服务器返 404 → 警告无法连接', async () => {
    const mock = await startMockStatsServer();
    mock.handler.current = (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    };
    try {
      await showStats({
        watch: false,
        detailed: false,
        host: '127.0.0.1',
        port: mock.port,
      });
      const out = cap.messages.join('\n');
      expect(out).toMatch(/无法连接到 ISR 服务器 metrics/);
      expect(out).toMatch(/请确保服务器正在运行/);
    } finally {
      await stopServer(mock.server);
    }
  });

  it('服务器返非法 JSON shape → 警告无法连接（payload 校验失败）', async () => {
    const mock = await startMockStatsServer();
    mock.handler.current = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ wrong: 'shape' }));
    };
    try {
      await showStats({
        watch: false,
        detailed: false,
        host: '127.0.0.1',
        port: mock.port,
      });
      expect(cap.messages.join('\n')).toMatch(/无法连接到 ISR 服务器 metrics/);
    } finally {
      await stopServer(mock.server);
    }
  });

  it('backend 非 memory/hybrid → snapshot 被拒绝', async () => {
    const mock = await startMockStatsServer();
    mock.handler.current = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ size: 1, max: 10, revalidating: 0, backend: 'some-unknown-backend' })
      );
    };
    try {
      await showStats({
        watch: false,
        detailed: false,
        host: '127.0.0.1',
        port: mock.port,
      });
      expect(cap.messages.join('\n')).toMatch(/无法连接/);
    } finally {
      await stopServer(mock.server);
    }
  });

  it('端口指向不存在的服务 → 静默被 catch 后 warn', async () => {
    // 指向 1 端口（privileged + 几乎肯定没监听）
    await showStats({
      watch: false,
      detailed: false,
      host: '127.0.0.1',
      port: 1,
    });
    expect(cap.messages.join('\n')).toMatch(/无法连接/);
  });
});
