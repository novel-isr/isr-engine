/**
 * TraceMiddleware —— W3C trace-context 解析与优先级（v2.1 修复）
 *
 * 修复前：只认 context.data.traceId / 自生成 UUID，完全不解析 W3C traceparent，
 * 导致 OTel / Datadog / Honeycomb 的 trace 链在 engine 这一跳断裂。
 *
 * 修复后：parseTraceparent() 严格按规范解析；traceMiddleware 优先级
 *   traceparent > context.data.traceId > X-Request-Id > 自生成
 */
import { describe, it, expect } from 'vitest';
import { parseTraceparent, traceMiddleware } from '../TraceMiddleware';
import type { ISRContext } from '../../types';

describe('parseTraceparent —— W3C trace-context 规范', () => {
  it('接受标准 version=00 格式', () => {
    const r = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(r).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      flags: '01',
    });
  });

  it('拒绝 undefined / 空字符串', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
  });

  it('拒绝非 00 版本（未来版本规范未定）', () => {
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
  });

  it('拒绝段数不对（分隔符错误）', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7')).toBeNull();
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra')
    ).toBeNull();
  });

  it('拒绝 trace-id 长度错误', () => {
    expect(parseTraceparent('00-4bf9-00f067aa0ba902b7-01')).toBeNull();
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736FF-00f067aa0ba902b7-01')
    ).toBeNull();
  });

  it('拒绝 trace-id / parent-id 非 hex 字符', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e47ZZ-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902ZZ-01')).toBeNull();
  });

  it('拒绝全 0 trace-id（规范禁止，常见于格式占位错误）', () => {
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
  });

  it('拒绝全 0 parent-id', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
  });

  it('大小写 hex 混合也识别（规范写"lowercase recommended"但未强制）', () => {
    // 规范只 recommend lowercase；我们的实现用 [0-9a-f]（不接受大写，偏严格）
    // 这条 test 锁定这个取舍
    const r = parseTraceparent('00-ABCDEFABCDEFABCDEFABCDEFABCDEFAB-00f067aa0ba902b7-01');
    expect(r).toBeNull();
  });

  it('trim 外侧空白', () => {
    const r = parseTraceparent('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  ');
    expect(r?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });
});

describe('traceMiddleware —— 优先级', () => {
  /** 构造最小 context + 跑中间件，返回最终 traceId */
  async function runWith(headers: Record<string, string | undefined>): Promise<string> {
    const context: ISRContext = {
      url: '/',
      renderModeType: 'isr',
      data: { traceId: '', requestId: '', anonId: '' },
      req: {
        headers: headers as Record<string, string | string[] | undefined>,
        cookies: {},
        query: {} as Record<string, string | string[] | undefined>,
        userAgent: 'test',
      },
    };
    // TraceMiddleware 清空了 context.data 的 traceId/requestId，
    // 但它的逻辑还是读 context.data?.traceId 作为 "上游框架已解析"兜底。
    // 为了只测 header 路径，这里传空 context.data。
    context.data = {} as ISRContext['data'];
    await traceMiddleware(context, async () => {});
    return context.data.traceId as string;
  }

  it('有 traceparent 时：traceId 取自 trace-id 段（不是自生成的 UUID）', async () => {
    const traceId = await runWith({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('traceparent 非法 → 回退 X-Request-Id', async () => {
    const traceId = await runWith({
      traceparent: 'bogus',
      'x-request-id': 'req-abc-123',
    });
    expect(traceId).toBe('req-abc-123');
  });

  it('无任何上游头 → 生成 `trace-<uuid>` 前缀', async () => {
    const traceId = await runWith({});
    expect(traceId).toMatch(/^trace-[0-9a-f-]+$/);
  });

  it('traceparent 优先于 X-Request-Id', async () => {
    const traceId = await runWith({
      traceparent: '00-abcdefabcdefabcdefabcdefabcdefab-0011223344556677-01',
      'x-request-id': 'should-not-win',
    });
    expect(traceId).toBe('abcdefabcdefabcdefabcdefabcdefab');
  });
});
