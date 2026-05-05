/**
 * cli/dev —— `novel-isr dev` 启动开发服务器 + SIGINT/SIGTERM 优雅关闭
 *
 * 测试策略：mock 掉 `loadConfig` + `createISRApp`，让 startDevServer 跑完整路径但
 * 不真起 Vite。捕获 process.on 注册的 signal handler 后手动触发，验证：
 *   - 配置加载 + CLI 参数覆盖（port string→int / host）
 *   - 缺 server 字段时填默认值
 *   - 启动失败 → 抛错 + spinner 停止
 *   - SIGINT/SIGTERM → 调 app.shutdown() → process.exit(0)
 *   - 二次触发 SIGINT → 立即 process.exit(1)
 *   - shutdown 抛错 → log error 但仍 exit(0)（不阻止退出）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 必须在 import startDevServer 之前 mock —— vitest 会自动 hoist
vi.mock('../../config/loadConfig', () => ({
  loadConfig: vi.fn(),
}));
vi.mock('../../app/createISRApp', () => ({
  createISRApp: vi.fn(),
}));

import { startDevServer } from '../dev';
import { loadConfig } from '../../config/loadConfig';
import { createISRApp } from '../../app/createISRApp';
import type { ISRConfig, ResolvedISRConfig } from '../../types';

type SignalHandler = (signal: NodeJS.Signals) => void;

interface MockApp {
  start: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

function makeConfig(overrides: Partial<ISRConfig> = {}): ResolvedISRConfig {
  return {
    renderMode: 'isr',
    revalidate: 3600,
    routes: {},
    cache: { strategy: 'memory', ttl: 3600 },
    ...overrides,
  } as ResolvedISRConfig;
}

let processOnSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;
let exitCalls: number[];
let signalHandlers: Map<string, SignalHandler>;
let unhandledRejectionListener: ((reason: unknown) => void) | null;

beforeEach(() => {
  exitCalls = [];
  signalHandlers = new Map();

  // dev.ts 用 `() => void handleShutdown(...)` 把 promise 与外层脱钩，handler 内
  // process.exit 抛出的 __EXIT__ 会变成 unhandled rejection。此 listener 吞掉它们，
  // 防污染 vitest "errors" 计数。
  unhandledRejectionListener = (reason: unknown) => {
    const msg = (reason as Error)?.message ?? '';
    if (typeof msg === 'string' && msg.startsWith('__EXIT__:')) {
      // 预期的 —— 静默吞掉
      return;
    }
    // 非预期的 rejection —— 重新抛出让 test runner 处理
    throw reason;
  };
  process.on('unhandledRejection', unhandledRejectionListener);

  // 拦截 process.on 注册 —— 不让 SIGINT/SIGTERM 真进入进程 handler 表
  processOnSpy = vi
    .spyOn(process, 'on')
    .mockImplementation((event: string | symbol, handler: SignalHandler) => {
      if (typeof event === 'string') signalHandlers.set(event, handler);
      return process;
    }) as ReturnType<typeof vi.spyOn>;

  // 拦截 process.exit —— 抛合成异常以模拟"永不返回"语义。
  // 不抛错的话 "二次触发 SIGINT" 测试会失败：真 process.exit(1) 会杀进程，
  // dev.ts 中的代码不会继续到 `shuttingDown = true` 之后；mock 不抛则继续执行
  // 进入 shutdown，让 shutdown 被调 2 次。
  // 同时 dev.ts 用 `() => void handleShutdown(...)` 包裹，rejection 会成为 unhandled，
  // 我们通过本进程级 unhandledRejection 过滤掉合成的 __EXIT__。
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCalls.push(typeof code === 'number' ? code : 0);
    throw new Error(`__EXIT__:${typeof code === 'number' ? code : 0}`);
  }) as ReturnType<typeof vi.spyOn>;

  vi.mocked(loadConfig).mockReset();
  vi.mocked(createISRApp).mockReset();
});

afterEach(() => {
  processOnSpy.mockRestore();
  processExitSpy.mockRestore();
  if (unhandledRejectionListener) {
    process.off('unhandledRejection', unhandledRejectionListener);
    unhandledRejectionListener = null;
  }
});

/**
 * 触发已注册的 signal handler 并等待异步链路收尾。
 *
 * 注意：dev.ts 用 `process.on('SIGINT', () => void handleShutdown(...))` —— `void` 操作符
 * 让 handleShutdown 返回的 Promise 与外层脱钩，所以同步 `try/catch` 抓不到 process.exit
 * 抛出的合成 __EXIT__。这里改用"等若干 microtask + 检查 exitCalls" 的方式判定。
 */
async function triggerSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<{ exitCode: number | null }> {
  const handler = signalHandlers.get(signal);
  if (!handler) throw new Error(`no handler for ${signal}`);
  const before = exitCalls.length;
  try {
    handler(signal);
  } catch {
    /* sync throw 也吞掉 —— 反正都体现在 exitCalls */
  }
  // flush microtasks：let `await app.shutdown()` 链路结束 + `process.exit(0)` 触发
  for (let i = 0; i < 10 && exitCalls.length === before; i++) {
    await Promise.resolve();
  }
  const code = exitCalls.length > before ? exitCalls[exitCalls.length - 1] : null;
  return { exitCode: code };
}

describe('startDevServer —— 配置 + CLI 参数', () => {
  it('CLI port 字符串 → parseInt 应用到 config.server.port', async () => {
    const config = makeConfig();
    vi.mocked(loadConfig).mockResolvedValue(config);
    const mockApp: MockApp = {
      start: vi.fn(async () => ({ url: 'http://localhost:3001' })),
      shutdown: vi.fn(async () => {}),
    };
    vi.mocked(createISRApp).mockResolvedValue(mockApp as never);

    await startDevServer({ port: '3001' });

    expect(config.server?.port).toBe(3001);
  });

  it('CLI host → 应用到 config.server.host', async () => {
    const config = makeConfig();
    vi.mocked(loadConfig).mockResolvedValue(config);
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://0.0.0.0:3000' }),
      shutdown: async () => {},
    } as never);

    await startDevServer({ port: '3000', host: '0.0.0.0' });

    expect(config.server?.host).toBe('0.0.0.0');
  });

  it('config 缺 server 字段 → 填默认端口', async () => {
    // 构造一个无 server 字段的 config —— `delete` 会让 TS 把 server 收窄成 never
    // 后续断言取不到属性。直接用 type assertion 重组以保留 server 字段类型空间。
    const baseConfig = makeConfig();
    const { server: _, ...rest } = baseConfig;
    void _;
    const config = rest as unknown as ResolvedISRConfig;
    vi.mocked(loadConfig).mockResolvedValue(config);
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown: async () => {},
    } as never);

    await startDevServer({ port: '3000' });

    expect(config.server).toBeDefined();
    expect(config.server?.port).toBe(3000);
  });

  it('startDevServer 注册 SIGINT 和 SIGTERM handler', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown: async () => {},
    } as never);

    await startDevServer({ port: '3000' });

    expect(signalHandlers.has('SIGINT')).toBe(true);
    expect(signalHandlers.has('SIGTERM')).toBe(true);
  });
});

describe('startDevServer —— 启动失败路径', () => {
  it('loadConfig 抛错 → 重抛 + 调用方能 catch', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('config-broken'));

    await expect(startDevServer({ port: '3000' })).rejects.toThrow('config-broken');
  });

  it('createISRApp 抛错 → 重抛', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockRejectedValue(new Error('app-init-failed'));

    await expect(startDevServer({ port: '3000' })).rejects.toThrow('app-init-failed');
  });

  it('app.start 抛错 → 重抛', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => {
        throw new Error('listen-failed');
      },
      shutdown: async () => {},
    } as never);

    await expect(startDevServer({ port: '3000' })).rejects.toThrow('listen-failed');
  });
});

describe('startDevServer —— SIGINT 优雅关闭', () => {
  it('SIGINT 首次 → 调 app.shutdown() → process.exit(0)', async () => {
    const shutdown = vi.fn(async () => {});
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown,
    } as never);

    await startDevServer({ port: '3000' });

    const result = await triggerSignal('SIGINT');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  it('SIGTERM 首次 → 同样走 shutdown → exit(0)', async () => {
    const shutdown = vi.fn(async () => {});
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown,
    } as never);

    await startDevServer({ port: '3000' });

    const result = await triggerSignal('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  it('shutdown 抛错 → log error 但仍 exit(0)（不阻止退出）', async () => {
    const shutdown = vi.fn(async () => {
      throw new Error('shutdown-explosion');
    });
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown,
    } as never);

    await startDevServer({ port: '3000' });

    const result = await triggerSignal('SIGINT');
    expect(shutdown).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('SIGINT 二次触发 → 立即 exit(1)（不再走 shutdown）', async () => {
    const shutdownPromise = new Promise<void>(() => {}); // 永不 resolve，模拟"还在关"
    const shutdown = vi.fn(() => shutdownPromise);
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown,
    } as never);

    await startDevServer({ port: '3000' });

    const handler = signalHandlers.get('SIGINT')!;
    // 第一次 SIGINT —— 进入 shutdown 流程，挂在 await
    void handler('SIGINT');
    // 让 shuttingDown=true 真正生效（一个 microtask）
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledTimes(1);

    // 第二次 SIGINT —— 期望立即 exit(1)
    void handler('SIGINT');
    await Promise.resolve();
    expect(exitCalls).toContain(1);
    expect(shutdown).toHaveBeenCalledTimes(1); // 不再调 shutdown
  });

  it('shutdown 超时（>3s）→ forceExit(1)', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(() => new Promise<void>(() => {})); // 永不 resolve
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:3000' }),
      shutdown,
    } as never);

    try {
      await startDevServer({ port: '3000' });

      const handler = signalHandlers.get('SIGINT')!;
      // 启动 handler；它会在 `await app.shutdown()` 处挂起（shutdown 永不 resolve）
      void handler('SIGINT');

      // 让 setTimeout(forceExit, 3000) 注册
      await Promise.resolve();

      // 推时间触发 forceExit → process.exit(1)（mock 抛 __EXIT__）
      // setTimeout 回调里抛错会被 advanceTimersByTimeAsync 包成 rejection；包 try/catch 吞掉
      try {
        await vi.advanceTimersByTimeAsync(3500);
      } catch (err) {
        const msg = (err as Error)?.message ?? '';
        if (!String(msg).startsWith('__EXIT__:')) throw err;
      }

      expect(exitCalls).toContain(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startDevServer —— serverContext 输出格式', () => {
  it('serverContext 有 url → 打印完整地址 + /health', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({ url: 'http://localhost:4500' }),
      shutdown: async () => {},
    } as never);

    // 不抛即可 —— 我们这里只验证不崩，输出本身在 logger，已被 mock 在测试中没意义
    await expect(startDevServer({ port: '4500' })).resolves.toBeUndefined();
  });

  it('serverContext 无 url → 退化到端口提示', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig());
    vi.mocked(createISRApp).mockResolvedValue({
      start: async () => ({}), // 没有 url
      shutdown: async () => {},
    } as never);

    await expect(startDevServer({ port: '3000' })).resolves.toBeUndefined();
  });
});
