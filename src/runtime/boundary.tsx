/**
 * 错误边界 + Suspense fallback —— 标准约定（Next.js error.tsx 同款 API）
 *
 * 业务页面用法（强烈推荐传自定义 fallback —— engine 默认只是兜底）：
 *
 *   // skeletons.tsx
 *   import { BookListSkeleton } from './skeletons';
 *
 *   // BookListError.tsx —— 富错误 UI 必须是 'use client'（要接 error / reset 实例 props）
 *   'use client';
 *   export function BookListError({ error, reset }: { error?: Error; reset?: () => void }) {
 *     return <div>...{error?.message}...<button onClick={reset}>重试</button></div>;
 *   }
 *
 *   // page.tsx (Server Component)
 *   <Boundary
 *     loading={<BookListSkeleton />}
 *     error={<BookListError />}        // ← 元素，不是函数；Boundary 会 cloneElement 注入 { error, reset }
 *     onError={(err) => Sentry.captureException(err)}
 *   >
 *     <BookList />
 *   </Boundary>
 *
 * 设计：
 * - loading / error 都是 ReactElement（不能是函数 —— RSC 无法跨 server→client 边界传 function）
 * - 内部 ReactErrorBoundary 在错误发生时 React.cloneElement(error, { error, reset })
 *   → 业务侧 'use client' 错误组件按 props 接收即可
 * - 简单纯静态 fallback（无需 error/reset）也 OK：`<div>出错了</div>`，注入的 props 自动忽略
 * - 嵌套：每层 <Boundary> 是独立隔离
 * - Streaming：与 React 19 Suspense 自然配合
 */
'use client';

import React from 'react';
import styles from './boundary.module.scss';

interface BoundaryProps {
  /** Suspense fallback —— 子组件 await 数据时显示 */
  loading?: React.ReactNode;
  /**
   * 错误边界 fallback —— 子组件抛错时显示。
   * 必须是 ReactElement（不能是 function，因 RSC 不能跨边界序列化函数）。
   * Boundary 内部会用 cloneElement 注入 `{ error, reset }` —— 'use client' 错误组件可接收这些 props。
   */
  error?: React.ReactElement;
  /** onError 钩子（上报到 Sentry / Datadog） */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: React.ReactNode;
}

interface ErrorState {
  error: Error | null;
}

interface InjectedFallbackProps {
  error?: Error;
  reset?: () => void;
}

class ReactErrorBoundary extends React.Component<
  {
    fallback?: React.ReactElement;
    onError?: (error: Error, info: React.ErrorInfo) => void;
    children: React.ReactNode;
  },
  ErrorState
> {
  state: ErrorState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      const injected: InjectedFallbackProps = { error: this.state.error, reset: this.reset };
      if (fallback) {
        return React.cloneElement(fallback, injected);
      }
      return <DefaultErrorFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({ error, reset }: { error?: Error; reset?: () => void }) {
  return (
    <div className={styles.errorRoot}>
      <p className={styles.errorRoot__title}>组件渲染异常</p>
      <p className={styles.errorRoot__message}>{error?.message ?? 'unknown error'}</p>
      <button onClick={reset ?? (() => location.reload())} className={styles.errorRoot__retry}>
        重试
      </button>
    </div>
  );
}

function DefaultLoadingFallback() {
  return <div className={styles.loadingRoot}>加载中…</div>;
}

/**
 * 一站式 Boundary —— 同时套 ErrorBoundary + Suspense
 * 业务最常用的形式：用 1 个组件框住有数据获取/有副作用的子树
 */
export function Boundary({ loading, error, onError, children }: BoundaryProps) {
  return (
    <ReactErrorBoundary fallback={error} onError={onError}>
      <React.Suspense fallback={loading ?? <DefaultLoadingFallback />}>{children}</React.Suspense>
    </ReactErrorBoundary>
  );
}

/** 仅错误边界（不需要 Suspense 时用）*/
export function ErrorBoundary({
  fallback,
  onError,
  children,
}: {
  fallback?: React.ReactElement;
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: React.ReactNode;
}) {
  return (
    <ReactErrorBoundary fallback={fallback} onError={onError}>
      {children}
    </ReactErrorBoundary>
  );
}
