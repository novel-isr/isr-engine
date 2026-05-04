/**
 * 根 App —— 这是一个 Server Component (没有 'use client' 指令).
 *
 * cacheTag('hello-home') 注册 ISR 失效标签:
 *   - 启动后 60s 内访问 /, 走 cache HIT, 毫秒返回
 *   - 60s 后访问 /, STALE 路径, 立即返回旧内容 + 后台异步重渲
 *   - 任何位置调 revalidateTag('hello-home') 立刻失效
 *
 * 路由系统由 isr-engine 内部解析 (基于 ssr.config.ts + URL pattern).
 * 你想加 client interactivity, 单独写带 'use client' 的组件然后 import 进来.
 */
import { cacheTag } from '@novel-isr/engine/rsc';

export interface AppProps {
  url: URL;
}

export function App({ url }: AppProps) {
  cacheTag('hello-home');
  const path = url.pathname;

  if (path === '/') {
    return (
      <main>
        <h1>Hello, isr-engine</h1>
        <p>This page is rendered as ISR (revalidate 60s).</p>
        <p>Generated at: {new Date().toISOString()}</p>
        <ul>
          <li>
            <a href='/about'>About (SSG)</a>
          </li>
          <li>
            <a href='/health'>Health (SSR)</a>
          </li>
        </ul>
      </main>
    );
  }

  if (path === '/about') {
    return (
      <main>
        <h1>About</h1>
        <p>This page is built once at build time (SSG).</p>
        <a href='/'>Back home</a>
      </main>
    );
  }

  if (path === '/health') {
    return (
      <main>
        <h1>OK</h1>
        <p>Rendered at {new Date().toISOString()} (no cache).</p>
      </main>
    );
  }

  return (
    <main>
      <h1>404</h1>
      <a href='/'>Home</a>
    </main>
  );
}
