'use client';

/**
 * 全局错误边界 —— 运行在浏览器环境，捕获 RSC 水合后的渲染异常
 */
import * as React from 'react';

import './error-boundary.style.scss';

export function GlobalErrorBoundary(props: { children?: React.ReactNode }): React.ReactElement {
  return <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>{props.children}</ErrorBoundary>;
}

interface ErrorComponentProps {
  error: Error;
  reset: () => void;
}

class ErrorBoundary extends React.Component<{
  children?: React.ReactNode;
  errorComponent: React.FC<ErrorComponentProps>;
}> {
  state: { error?: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const error = this.state.error;
    if (error) {
      return <this.props.errorComponent error={error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultGlobalErrorPage(props: ErrorComponentProps) {
  return (
    <html lang='zh-CN'>
      <head>
        <title>渲染异常 · Novel Rating</title>
      </head>
      <body className='eb-body'>
        <h1 className='eb-title'>出错了</h1>
        <pre className='eb-message'>
          {import.meta.env.DEV && props.error?.message ? props.error.message : '发生未知错误'}
        </pre>
        <button
          type='button'
          onClick={() => {
            React.startTransition(() => props.reset());
          }}
          className='eb-retry'
        >
          重试
        </button>
      </body>
    </html>
  );
}
