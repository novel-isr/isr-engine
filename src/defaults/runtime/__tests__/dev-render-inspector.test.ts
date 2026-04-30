import { describe, expect, it } from 'vitest';

import {
  resolveDevRenderInspectorView,
  shouldDeferDevRenderInspectorMount,
} from '../dev-render-inspector';

describe('dev render inspector view model', () => {
  it('shows explicit render mode from response headers', () => {
    const view = resolveDevRenderInspectorView({
      href: 'http://localhost:3000/feed?mode=ssr',
      state: {
        mode: 'ssr',
        modeSource: 'query-override',
        strategy: 'rsc-ssr',
        cache: 'bypass',
        fallback: 'false',
      },
    });

    expect(view).toMatchObject({
      resolvedMode: 'ssr',
      modeCode: 'SSR',
      modeLabel: 'SSR 实时',
      modeSource: 'query-override',
      strategy: 'rsc-ssr',
      cacheLabel: 'BYPASS · 实时',
    });
  });

  it('infers render mode from URL before inspector headers arrive', () => {
    const view = resolveDevRenderInspectorView({
      href: 'http://localhost:3000/about?mode=ssg',
      state: null,
    });

    expect(view).toMatchObject({
      resolvedMode: 'ssg',
      modeCode: 'SSG',
      modeSource: 'url-inferred',
      cacheLabel: '检测中',
    });
  });

  it('treats csr shell as the visible render mode', () => {
    const view = resolveDevRenderInspectorView({
      href: 'http://localhost:3000/?__csr-shell=1',
      state: {
        mode: 'isr',
        modeSource: 'config',
        strategy: 'csr-shell',
        cache: 'miss',
        fallback: 'true',
      },
    });

    expect(view).toMatchObject({
      resolvedMode: 'csr',
      modeCode: 'CSR',
      modeLabel: 'CSR 降级',
      cacheTone: 'bypass',
      cacheLabel: 'BYPASS · 降级',
      fallbackActive: true,
    });
  });

  it('defers mounting until document.body is available', () => {
    expect(shouldDeferDevRenderInspectorMount({ body: null })).toBe(true);
    expect(shouldDeferDevRenderInspectorMount({ body: {} as HTMLElement })).toBe(false);
  });
});
