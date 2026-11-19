/**
 * Logger —— 单例日志（chalk 彩色输出 + 可选文件持久化 + ora spinner）
 *
 * 测试覆盖：
 *   1) 单例：getInstance() 多次返回同一实例，options 累加更新
 *   2) verbose=false 时 DEBUG/VERBOSE 被压制，其他级别正常
 *   3) logFile 写入：文件不存在自动 mkdir，append 模式（多次 log 累积）
 *   4) Error 实例 → stack 优先 message 兜底
 *   5) 对象 → JSON.stringify(2) 格式化
 *   6) traceId / requestId 通过 RequestContext ALS 注入
 *   7) spinner 启停（避免与日志冲突）
 *
 * 不测：chalk 实际颜色码（终端依赖），ora spinner 字符（环境依赖）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';
import { Logger, LogLevel } from '../Logger';
import { requestContext } from '../../context/RequestContext';

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

/** 提取 console.log 收到的所有 message（去 chalk 颜色码） */
function getLoggedMessages(): string[] {
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\[[0-9;]*m/g;
  const calls = consoleLogSpy.mock.calls as unknown[][];
  return calls.map(call => String(call[0] ?? '').replace(ansiRe, ''));
}

describe('Logger.getInstance —— 单例', () => {
  it('多次调用返回同一实例', () => {
    const a = Logger.getInstance();
    const b = Logger.getInstance();
    expect(a).toBe(b);
  });

  it('options.verbose 多次调用被累加更新', () => {
    Logger.getInstance({ verbose: false });
    const inst = Logger.getInstance({ verbose: true });
    inst.debug('hidden-or-visible');
    // verbose=true 时 debug 应被打印
    const msgs = getLoggedMessages();
    expect(msgs.some(m => m.includes('hidden-or-visible'))).toBe(true);
  });
});

describe('Logger 级别过滤', () => {
  it('verbose=false 时 DEBUG / VERBOSE 被压制', () => {
    const logger = Logger.getInstance({ verbose: false });
    logger.debug('should-not-show-debug');
    logger.verbose('should-not-show-verbose');
    logger.info('should-show-info');

    const msgs = getLoggedMessages();
    expect(msgs.some(m => m.includes('should-show-info'))).toBe(true);
    expect(msgs.some(m => m.includes('should-not-show-debug'))).toBe(false);
    expect(msgs.some(m => m.includes('should-not-show-verbose'))).toBe(false);
  });

  it('verbose=true 时所有级别都打印', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.debug('debug-line');
    logger.verbose('verbose-line');
    logger.info('info-line');
    logger.warn('warn-line');
    logger.error('error-line');
    logger.success('success-line');

    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('debug-line');
    expect(msgs).toContain('verbose-line');
    expect(msgs).toContain('info-line');
    expect(msgs).toContain('warn-line');
    expect(msgs).toContain('error-line');
    expect(msgs).toContain('success-line');
  });

  it('每条日志包含 [LEVEL] 标签', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.success('s');

    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toMatch(/\[ERROR\]/);
    expect(msgs).toMatch(/\[WARN\]/);
    expect(msgs).toMatch(/\[INFO\]/);
    expect(msgs).toMatch(/\[SUCCESS\]/);
  });
});

describe('Logger 消息格式化', () => {
  it('Error 实例 → stack 字段优先输出', () => {
    const logger = Logger.getInstance({ verbose: true });
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at fake.ts:1:1';
    logger.error(err);
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('boom');
    expect(msgs).toContain('at fake.ts:1:1');
  });

  it('Error 无 stack → 退到 message', () => {
    const logger = Logger.getInstance({ verbose: true });
    const err = new Error('only-message');
    delete (err as { stack?: string }).stack;
    logger.error(err);
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('only-message');
  });

  it('普通对象 → JSON.stringify 缩进 2 空格', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.info({ a: 1, b: { c: 'nested' } });
    const output = getLoggedMessages().at(-1)!;
    const message = JSON.parse(output.slice(output.indexOf('message=') + 'message='.length));
    expect(message).toContain('"a": 1');
    expect(message).toContain('"c": "nested"');
  });

  it('accepts objects whose JSON representation is undefined', () => {
    const logger = Logger.getInstance({ verbose: true });
    expect(() => logger.info({ toJSON: () => undefined })).not.toThrow();
    const message = String(consoleLogSpy.mock.calls.at(-1)?.[0]);
    expect(message).toContain('[INFO]');
    expect(message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('多参数拼接（用空格连接）', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.info('part1', 'part2', 42);
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('part1 part2 42');
  });

  it('包含 ISO 时间戳', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.info('hello');
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});

describe('Logger.logFile —— 文件持久化', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logger-'));
  });
  afterEach(async () => {
    Logger.getInstance({ logFile: '' });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('logFile 配置 → 自动创建目录 + 写入文件', async () => {
    const logFile = path.join(tmpDir, 'nested/sub/app.log');
    const logger = Logger.getInstance({ verbose: false, logFile });
    logger.info('persisted-line');

    const content = await fs.readFile(logFile, 'utf8');
    expect(content).toContain('persisted-line');
    expect(JSON.parse(content.trim())).toMatchObject({
      severity: 'info',
      args: ['persisted-line'],
    });
    // 文件中不应有 ANSI 颜色码
    // eslint-disable-next-line no-control-regex
    expect(content).not.toMatch(/\[/);
  });

  it('keeps untrusted messages and context identifiers inside one physical log record', async () => {
    const logFile = path.join(tmpDir, 'untrusted.log');
    const logger = Logger.getInstance({ logFile });
    requestContext.run({ traceId: 'trace\nforged', requestId: 'req\rforged', anonId: 'anon' }, () =>
      logger.info('input\r\n[ERROR] forged\u001b[2J\u2028another')
    );
    const content = await fs.readFile(logFile, 'utf8');
    expect(content.split('\n')).toHaveLength(2);
    expect(content).toContain('trace\\nforged');
    expect(content).toContain('req\\rforged');
    expect(content).toContain('input\\r\\n[ERROR] forged\\u001b[2J\\u2028another');
    const consoleMessage = String(consoleLogSpy.mock.calls.at(-1)?.[0]);
    expect(consoleMessage).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('多次 log → 累加（append 模式）', async () => {
    const logFile = path.join(tmpDir, 'append.log');
    const logger = Logger.getInstance({ logFile });
    logger.info('line-1');
    logger.warn('line-2');
    logger.error('line-3');

    const content = await fs.readFile(logFile, 'utf8');
    expect(content).toContain('line-1');
    expect(content).toContain('line-2');
    expect(content).toContain('line-3');
    expect(content.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  it('persists separate context, arguments and errors in one JSONL record', async () => {
    const logger = Logger.getInstance({ logFile: path.join(tmpDir, 'records.log') });
    const input = 'value\r\n[ERROR] forged\u001b[2J\u0085\u2028\u2029';
    const error = new Error(input);
    error.stack = `Error: ${input}\n    at remote:1:2`;
    const circular: Record<string, unknown> = { input, count: 42n };
    circular.self = circular;

    requestContext.run(
      { traceId: 'trace] [ERROR] forged\n', requestId: 'req\rforged', anonId: 'anon' },
      () => logger.warn(input, circular, error)
    );

    const content = await fs.readFile(path.join(tmpDir, 'records.log'), 'utf8');
    expect(content.split('\n')).toHaveLength(2);
    // eslint-disable-next-line no-control-regex
    expect(content.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(JSON.parse(content)).toMatchObject({
      severity: 'warn',
      traceId: 'trace] [ERROR] forged\n',
      requestId: 'req\rforged',
      args: [input, { input, count: '42n', self: '[Circular]' }, { name: 'Error', message: input }],
      errors: [{ argument: 2, error: { name: 'Error', message: input, stack: error.stack } }],
    });
    const consoleMessage = getLoggedMessages().at(-1)!;
    expect(consoleMessage).toContain('[WARN]');
    expect(consoleMessage).toContain('traceId="trace] [ERROR] forged\\n"');
    // eslint-disable-next-line no-control-regex
    expect(consoleMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  it('keeps logging when argument serialization throws', async () => {
    const logFile = path.join(tmpDir, 'unserializable.log');
    const logger = Logger.getInstance({ logFile });
    expect(() =>
      logger.info({
        toJSON() {
          throw new Error('cannot serialize');
        },
      })
    ).not.toThrow();
    expect(JSON.parse(await fs.readFile(logFile, 'utf8')).args).toEqual([
      '[Unserializable log argument]',
    ]);
  });

  it('snapshots caller arguments once for both output destinations', async () => {
    const logFile = path.join(tmpDir, 'snapshot.log');
    const logger = Logger.getInstance({ logFile });
    let serializations = 0;
    logger.info({ toJSON: () => ({ snapshot: ++serializations }) });
    expect(JSON.parse(await fs.readFile(logFile, 'utf8')).args).toEqual([{ snapshot: 1 }]);
    expect(getLoggedMessages().at(-1)).toContain('snapshot');
    expect(serializations).toBe(1);
  });

  it('reports destination errors as one encoded stderr record and continues console logging', async () => {
    const destinationSpy = vi.spyOn(pino, 'destination');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = Logger.getInstance({ logFile: path.join(tmpDir, 'failed.log') });
      const destination = destinationSpy.mock.results.at(-1)!.value;
      const closed = vi.fn();
      destination.once('close', closed);
      destination.emit('error', new Error('disk failed\nforged\u001b[2J'));
      expect(() => logger.info('console survives')).not.toThrow();
      expect(getLoggedMessages().at(-1)).toContain('console survives');
      const diagnostic = String(stderrSpy.mock.calls[0]?.[0]);
      // eslint-disable-next-line no-control-regex
      expect(diagnostic.trimEnd()).not.toMatch(/[\r\n\u001b]/);
      expect(diagnostic).toContain('disk failed\\nforged\\u001b[2J');
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    } finally {
      destinationSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('closes owned destinations when replacing or disabling file output', async () => {
    const destinationSpy = vi.spyOn(pino, 'destination');
    try {
      const firstFile = path.join(tmpDir, 'first.log');
      const secondFile = path.join(tmpDir, 'second.log');
      const logger = Logger.getInstance({ logFile: firstFile });
      const firstDestination = destinationSpy.mock.results.at(-1)!.value;
      const firstClosed = vi.fn();
      firstDestination.once('close', firstClosed);
      logger.info('first');
      Logger.getInstance({ logFile: firstFile });
      expect(firstClosed).not.toHaveBeenCalled();
      Logger.getInstance({ logFile: secondFile });
      const secondDestination = destinationSpy.mock.results.at(-1)!.value;
      const secondClosed = vi.fn();
      secondDestination.once('close', secondClosed);
      await vi.waitFor(() => expect(firstClosed).toHaveBeenCalledOnce());
      logger.info('second');
      Logger.getInstance({ logFile: '' });
      await vi.waitFor(() => expect(secondClosed).toHaveBeenCalledOnce());
      logger.info('console-only');
      expect(JSON.parse(await fs.readFile(firstFile, 'utf8')).args).toEqual(['first']);
      expect(JSON.parse(await fs.readFile(secondFile, 'utf8')).args).toEqual(['second']);
      expect(getLoggedMessages().at(-1)).toContain('console-only');
    } finally {
      destinationSpy.mockRestore();
    }
  });

  it('rejects runtime-invalid levels before writing a record', async () => {
    const logFile = path.join(tmpDir, 'levels.log');
    const logger = Logger.getInstance({ logFile });
    expect(() => logger.log('info\n[ERROR]' as LogLevel, 'forged')).toThrow(TypeError);
    logger.info('valid');
    const records = (await fs.readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ severity: 'info', args: ['valid'] });
  });

  it('rejects malformed log file configuration without treating it as a message', () => {
    expect(() => Logger.getInstance({ logFile: 'bad\u0000path' })).toThrow(TypeError);
    expect(() => Logger.getInstance({ logFile: 42 as unknown as string })).toThrow(TypeError);
  });

  it('文件写入失败 → 不抛错，stderr 提示', async () => {
    // 故意指向一个无效路径（系统目录权限问题在 macOS 上不可靠）—— 改用 mkdtemp 后立刻 chmod
    const logFile = path.join(tmpDir, 'will-fail.log');
    // 先创建一个目录，让"写文件"操作失败
    await fs.mkdir(logFile, { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = Logger.getInstance({ logFile });
      logger.info('should-not-crash');
      // 一旦写入失败，stderr 会被调用一次
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0][0]);
      expect(written).toContain('Failed to write to log file');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('Logger 与 RequestContext 集成（traceId / requestId）', () => {
  it('在 ALS 作用域内 → 日志包含 traceId + requestId', () => {
    const logger = Logger.getInstance({ verbose: true });
    requestContext.run(
      { traceId: 'trace-abc-123', requestId: 'req-xyz-456', anonId: 'anon-test' },
      () => {
        logger.info('with-trace');
      }
    );
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('trace-abc-123');
    expect(msgs).toContain('req-xyz-456');
    expect(msgs).toContain('with-trace');
  });

  it('ALS 外 → traceId="system"，requestId 不出现（because "unknown" 触发隐藏）', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.info('outside-als');
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('system');
    // requestId="unknown" 时 requestTag 为空 → 不应在输出中看到 [unknown]
    expect(msgs).not.toContain('[unknown]');
  });
});

describe('Logger.spin / stopSpinner —— 进度提示', () => {
  it('spin 创建 ora 实例', () => {
    const logger = Logger.getInstance();
    const sp = logger.spin('processing...');
    expect(sp).toBeDefined();
    expect(typeof sp.start).toBe('function');
    logger.stopSpinner('done');
  });

  it('stopSpinner(message, success=true) 调用 succeed', () => {
    const logger = Logger.getInstance();
    const sp = logger.spin('working');
    const succeedSpy = vi.spyOn(sp, 'succeed');
    logger.stopSpinner('finished');
    expect(succeedSpy).toHaveBeenCalledWith('finished');
  });

  it('stopSpinner(message, success=false) 调用 fail', () => {
    const logger = Logger.getInstance();
    const sp = logger.spin('working');
    const failSpy = vi.spyOn(sp, 'fail');
    logger.stopSpinner('boom', false);
    expect(failSpy).toHaveBeenCalledWith('boom');
  });

  it('stopSpinner 后再 stopSpinner → 安全 noop', () => {
    const logger = Logger.getInstance();
    logger.spin('x');
    logger.stopSpinner();
    expect(() => logger.stopSpinner()).not.toThrow();
  });
});

describe('Logger.log 主入口 —— 与级别 helper 等价', () => {
  it('log(LogLevel.INFO, msg) 等价 info(msg)', () => {
    const logger = Logger.getInstance({ verbose: true });
    logger.log(LogLevel.INFO, 'via-log-method');
    const msgs = getLoggedMessages().join('\n');
    expect(msgs).toContain('via-log-method');
    expect(msgs).toMatch(/\[INFO\]/);
  });
});
