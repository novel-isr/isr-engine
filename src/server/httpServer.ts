/**
 * HTTP 服务器启动器
 *
 * Node origin 只启动 HTTP/1.1。
 *
 * TLS / HTTP/2 / HTTP/3 / Brotli 属于 CDN / Ingress / Nginx / Envoy / ALB 边界。
 * isr-engine 负责 SSR/ISR/RSC/cache/revalidate，不把网关层协议暴露为业务配置。
 */

import { createServer as createHttpServer, Server } from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import { Logger } from '@/logger/Logger';
import type { ServerConfig, ServerInstance, ServerStartResult } from './types';

const logger = Logger.getInstance();

const DEFAULT_TIMEOUTS = {
  requestTimeoutMs: 60_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
  maxRequestsPerSocket: 0,
};
const LISTEN_BACKLOG = 8192;

function applyHttpTimeouts(server: Server): void {
  server.requestTimeout = DEFAULT_TIMEOUTS.requestTimeoutMs;
  server.headersTimeout = DEFAULT_TIMEOUTS.headersTimeoutMs;
  server.keepAliveTimeout = DEFAULT_TIMEOUTS.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = DEFAULT_TIMEOUTS.maxRequestsPerSocket;
  server.setTimeout(DEFAULT_TIMEOUTS.idleTimeoutMs);
  (server as unknown as { __shutdownTimeoutMs?: number }).__shutdownTimeoutMs =
    DEFAULT_TIMEOUTS.shutdownTimeoutMs;
}

function getServerAddress(server: Server): { address: string; port: number } {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    const info = addr as AddressInfo;
    return { address: info.address, port: info.port };
  }
  return { address: '<unknown>', port: 0 };
}

function formatHostForUrl(address: string): string {
  if (address === '::' || address === '0.0.0.0' || address === '') {
    return 'localhost';
  }
  if (address.includes(':') && !address.startsWith('[')) {
    return `[${address}]`;
  }
  return address;
}

/** 启动 HTTP/1.1 服务器 */
export function startHttp1Server(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  const maxAttempts = config.allowPortFallback === true ? 20 : 1;
  const startPort = config.port;

  return new Promise((resolve, reject) => {
    const server = createHttpServer(app);
    applyHttpTimeouts(server);

    let attempt = 0;
    const listen = (port: number) => {
      server.listen({ port, host: config.host, backlog: LISTEN_BACKLOG });
    };

    server.on('listening', () => {
      const { address, port } = getServerAddress(server);
      const url = `http://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`HTTP/1.1 服务器已启动: ${url}`);
      resolve({ server, url });
    });

    server.on('error', error => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EADDRINUSE' && attempt + 1 < maxAttempts) {
        attempt += 1;
        const nextPort = startPort + attempt;
        logger.warn(`端口 ${startPort + attempt - 1} 已占用，尝试 ${nextPort}`);
        listen(nextPort);
        return;
      }
      reject(error);
    });

    listen(startPort);
  });
}

/** 启动 Node origin 服务器 */
export function startServer(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  return startHttp1Server(app, config);
}

/**
 * 强制关闭服务器 —— 同时释放已建立的 keep-alive 连接，避免端口被占用
 *
 * 关闭策略：
 *   1. 调用 `server.closeAllConnections()` 切断所有活跃连接（Node 18.2+）
 *   2. `server.close()` 异步等待 listener 关闭
 *   3. `server.unref()` 让进程可以立即退出
 *   4. shutdownTimeoutMs 后即使 close() 未回调也强制 resolve（防僵死）
 */
export function closeServer(server: ServerInstance): Promise<void> {
  return new Promise(resolve => {
    const shutdownTimeoutMs =
      (server as unknown as { __shutdownTimeoutMs?: number }).__shutdownTimeoutMs ??
      DEFAULT_TIMEOUTS.shutdownTimeoutMs;

    const typedServer = server as unknown as {
      close?: (cb?: () => void) => void;
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
      unref?: () => void;
    };

    // 1. 切断 keep-alive 连接 —— 否则 close() 会一直等已连接客户端超时
    try {
      typedServer.closeAllConnections?.();
    } catch {
      try {
        typedServer.closeIdleConnections?.();
      } catch {
        // 两个都没有时依赖 close + timeout
      }
    }

    // 2. 让事件循环允许进程退出
    try {
      typedServer.unref?.();
    } catch {
      // unref 失败不影响关闭
    }

    // 3. close() + 超时兜底
    let resolved = false;
    const safeResolve = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    const timeout = setTimeout(safeResolve, shutdownTimeoutMs);
    if (typeof typedServer.close === 'function') {
      typedServer.close(() => {
        clearTimeout(timeout);
        safeResolve();
      });
    } else {
      clearTimeout(timeout);
      safeResolve();
    }
  });
}
