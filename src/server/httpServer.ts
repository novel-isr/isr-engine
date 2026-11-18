/**
 * HTTP 服务器启动器
 *
 * Node origin 只启动 HTTP/1.1。
 *
 * TLS / HTTP/2 / HTTP/3 / Brotli 属于 CDN / Ingress / Nginx / Envoy / ALB 边界。
 * isr-engine 负责 SSR/ISR/RSC/cache/revalidate，不把网关层协议暴露为业务配置。
 */

import { createServer as createHttpServer, Server } from 'http';
import type { AddressInfo, Socket } from 'net';
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
const serverSockets = new WeakMap<ServerInstance, Set<Socket>>();

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
  const maxAttempts = config.strictPort === false ? 20 : 1;
  const startPort = config.port;

  return new Promise((resolve, reject) => {
    const server = createHttpServer(app);
    applyHttpTimeouts(server);
    const sockets = new Set<Socket>();
    serverSockets.set(server, sockets);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

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

const closingServers = new WeakMap<ServerInstance, Promise<void>>();

/** Stop accepting requests, drain active responses, then force overdue connections closed. */
export function closeServer(server: ServerInstance): Promise<void> {
  const existing = closingServers.get(server);
  if (existing) return existing;
  const closing = new Promise<void>((resolve, reject) => {
    const shutdownTimeoutMs =
      (server as ServerInstance & { __shutdownTimeoutMs?: number }).__shutdownTimeoutMs ??
      DEFAULT_TIMEOUTS.shutdownTimeoutMs;
    const timeout = setTimeout(() => {
      try {
        server.closeAllConnections();
        // Node excludes upgraded connections from closeAllConnections.
        for (const socket of serverSockets.get(server) ?? []) socket.destroy();
      } catch (error) {
        reject(error);
      }
    }, shutdownTimeoutMs);
    try {
      // close first prevents new connections racing with idle/forced connection cleanup.
      server.close(error => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
  closingServers.set(server, closing);
  return closing;
}
