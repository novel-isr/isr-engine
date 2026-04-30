'use client';

import * as React from 'react';

import { GlobalErrorBoundary } from './error-boundary';

/**
 * SSR 与浏览器 hydrate 共用的根包装。
 *
 * React.useId 会把 owner path 编进服务端 id。Radix Tabs/Menu 等组件依赖 useId，
 * 所以服务端 HTML 和客户端 hydrate 必须从同一层根包装开始渲染，否则会出现
 * `aria-controls/id` 前缀不一致的 hydration mismatch。
 */
export function HydrationShell(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <React.StrictMode>
      <GlobalErrorBoundary>{props.children}</GlobalErrorBoundary>
    </React.StrictMode>
  );
}
