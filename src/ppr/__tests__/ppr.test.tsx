/**
 * PPR (Partial Prerendering) e2e 测试 —— 真实调用 React 19 的 prerender + resumeAndPrerender
 *
 * 验证：
 *   - prerender 返回 { prelude, postponed }
 *   - prelude 是合法 HTML（含静态部分）
 *   - postponed 可序列化（用于持久化）
 *   - resumeAndPrerender 用 postponed 接续渲染（动态部分被填充）
 *   - 静态部分 + 动态部分组合后是完整 HTML
 */
import { describe, it, expect } from 'vitest';
import React, { Suspense } from 'react';
import {
  prerenderShell,
  resumeShell,
  serializePostponed,
  deserializePostponed,
  streamToText,
} from '../index';

// 真 PPR 需要 React.unstable_postpone() 主动中断 —— Suspense + 永不 resolve 只会等
// React 19 在 static.edge 里的 prerender 遇到 postpone() 调用时才停下 + 写入 postponed
// （对应 Next 14 PPR 实现方式）
const postpone = (React as unknown as { unstable_postpone?: (reason?: string) => never })
  .unstable_postpone;

// 真 PPR 场景：静态壳 + Suspense 包动态段；构建期 postpone()，请求期 resolve
function App({ dynamic }: { dynamic: React.ReactElement }): React.ReactElement {
  return (
    <html lang='en'>
      <head>
        <title>PPR Demo</title>
      </head>
      <body>
        <header>静态导航 (秒出)</header>
        <main>
          <Suspense fallback={<div data-fallback>Loading...</div>}>{dynamic}</Suspense>
        </main>
        <footer>静态页脚 (秒出)</footer>
      </body>
    </html>
  );
}

function PostponingChild(): React.ReactElement {
  if (postpone) postpone('PPR boundary: dynamic data will be filled at request time');
  return <div data-dynamic>SHOULD-NOT-APPEAR-IN-PRELUDE</div>;
}

function ResumedChild({ data }: { data: string }): React.ReactElement {
  return <div data-dynamic>{data}</div>;
}

describe.skipIf(!postpone)('PPR: prerender + resume', () => {
  it('prerenderShell 在 postpone() 处停下，返回 prelude + postponed state', async () => {
    const result = await prerenderShell(<App dynamic={<PostponingChild />} />);

    expect(result.prelude).toBeInstanceOf(ReadableStream);
    expect(result.postponed).toBeDefined();

    const html = await streamToText(result.prelude);
    // 静态部分已渲染
    expect(html).toContain('静态导航 (秒出)');
    expect(html).toContain('静态页脚 (秒出)');
    expect(html).toContain('<title>PPR Demo</title>');
    // postpone() 之后的内容不出现
    expect(html).not.toContain('SHOULD-NOT-APPEAR-IN-PRELUDE');
  });

  it('postponed 可 JSON 序列化 + 反序列化 round-trip', async () => {
    const { postponed } = await prerenderShell(<App dynamic={<PostponingChild />} />);
    const serialized = serializePostponed(postponed);
    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);
    const restored = deserializePostponed(serialized);
    expect(restored).toEqual(postponed);
  });

  it('resumeShell 用 postponed 接续渲染，动态部分填上真实数据', async () => {
    const { postponed } = await prerenderShell(<App dynamic={<PostponingChild />} />);
    const resumedStream = await resumeShell(
      <App dynamic={<ResumedChild data='真实动态数据 from resume' />} />,
      postponed
    );
    const html = await streamToText(resumedStream);
    expect(html).toContain('真实动态数据 from resume');
  });
});

describe.skipIf(postpone)('PPR (skipped: React.unstable_postpone unavailable)', () => {
  it('skip notice', () => {
    expect(true).toBe(true);
  });
});
