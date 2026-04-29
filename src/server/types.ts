/**
 * 服务器类型定义
 */

import type { Express } from 'express';
import type { Server } from 'node:http';
import type { ViteDevServer } from 'vite';

/** 路由注册函数 */
export type RouteSetupFn = (requestHandler: Express) => void;

/** 服务器协议 */
export type ServerProtocol = 'http1.1' | 'https';

/** 服务器配置 */
export interface ServerConfig {
  port: number;
  host?: string;
  /**
   * When false, retry the next available port on EADDRINUSE. Keep production
   * strict by default; dev server can opt into fallback ports.
   */
  strictPort?: boolean;
  protocol?: ServerProtocol;
  ssl?: { key: string; cert: string } | null;
  /**
   * Public edge hardening knobs. Defaults are intentionally conservative for
   * SSR/RSC workloads and should normally be paired with an upstream proxy.
   */
  timeouts?: {
    requestTimeoutMs?: number;
    headersTimeoutMs?: number;
    keepAliveTimeoutMs?: number;
    idleTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    maxRequestsPerSocket?: number;
  };
}

/** HTTP / HTTPS 服务器实例 */
export type ServerInstance = Server;

/** startServer 返回值 */
export interface ServerStartResult {
  server: ServerInstance;
  url: string;
}

/** 服务器上下文 */
export interface ServerContext {
  /** Express 请求处理器 */
  requestHandler: Express;
  /** Vite 开发中间件（仅开发模式） */
  viteDevMiddleware: ViteDevServer | null;
  /** 底层 HTTP 服务器实例 */
  httpServer: ServerInstance | null;
  /** 是否开发模式 */
  isDev: boolean;
  /** 已加载的生产 manifest（仅生产模式） */
  manifest: Record<string, unknown> | null;
  /** 服务启动 URL（startServer 填入） */
  url?: string;
}
