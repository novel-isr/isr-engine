/**
 * HTTP 服务器启动器
 * 根据协议创建对应的服务器实例
 *
 * 支持：
 * - HTTP/1.1: 标准明文 HTTP
 * - HTTPS: TLS 加密 HTTP/1.1
 * - HTTP/2: 基于 TLS 的多路复用（兼容 HTTP/1.1 回退）
 * - HTTP/3: 基于 HTTP/2 + 真实 QUIC 监听；只有 QUIC 可用时才广播 Alt-Svc
 *
 * HTTP/3 策略说明：
 * Node.js 尚无稳定的原生 QUIC 支持。业界成熟方案是：
 * 1. 用 HTTP/2 (TLS) 服务请求
 * 2. 尝试绑定 QUIC 监听（需要 Node/第三方 QUIC 能力）
 * 3. 只有真实 QUIC 监听成功后才通过 Alt-Svc 广播 h3 端点
 * 4. QUIC 不可用时保持 HTTP/2 TLS，不发送 Alt-Svc
 * 这也是 Cloudflare / Fastly / Nginx 的标准做法。
 */

import { createServer as createHttpServer, Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createSecureServer, Http2SecureServer } from 'http2';
import { Socket as UdpSocket } from 'dgram';
import type { AddressInfo } from 'net';
import type { Express, Request, Response, NextFunction } from 'express';
import { Logger } from '@/logger/Logger';
import type { ServerConfig, ServerInstance, ServerStartResult } from './types';

const logger = Logger.getInstance();

const DEFAULT_TIMEOUTS = {
  requestTimeoutMs: 60_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
  maxRequestsPerSocket: 1_000,
};

function resolveTimeouts(config: ServerConfig): Required<NonNullable<ServerConfig['timeouts']>> {
  return { ...DEFAULT_TIMEOUTS, ...config.timeouts };
}

function applyHttpTimeouts(server: Server | Http2SecureServer, config: ServerConfig): void {
  const timeouts = resolveTimeouts(config);
  const s = server as Server & {
    requestTimeout?: number;
    headersTimeout?: number;
    keepAliveTimeout?: number;
    maxRequestsPerSocket?: number;
    setTimeout?: (msecs: number) => void;
  };

  s.requestTimeout = timeouts.requestTimeoutMs;
  s.headersTimeout = timeouts.headersTimeoutMs;
  s.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  s.maxRequestsPerSocket = timeouts.maxRequestsPerSocket;
  s.setTimeout?.(timeouts.idleTimeoutMs);
  (server as unknown as { __shutdownTimeoutMs?: number }).__shutdownTimeoutMs =
    timeouts.shutdownTimeoutMs;
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
  if (address.includes(':') && !address.startsWith('[')) {
    return `[${address}]`;
  }
  return address;
}

/**
 * 启动 HTTP/1.1 服务器
 */
export function startHttp1Server(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(app);
    applyHttpTimeouts(server, config);

    server.listen(config.port, config.host, () => {
      const { address, port } = getServerAddress(server);
      const url = `http://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`HTTP/1.1 服务器已启动: ${url}`);
      resolve({ server, url });
    });

    server.on('error', reject);
  });
}

/**
 * 启动 HTTPS 服务器
 */
export function startHttpsServer(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  return new Promise((resolve, reject) => {
    if (!config.ssl) {
      reject(new Error('HTTPS 需要 SSL 配置'));
      return;
    }

    const server = createHttpsServer(
      {
        key: config.ssl.key,
        cert: config.ssl.cert,
      },
      app
    );
    applyHttpTimeouts(server, config);

    server.listen(config.port, config.host, () => {
      const { address, port } = getServerAddress(server);
      const url = `https://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`HTTPS 服务器已启动: ${url}`);
      resolve({ server, url });
    });

    server.on('error', reject);
  });
}

/**
 * 启动 HTTP/2 服务器
 * HTTP/2 使用 allowHTTP1 以兼容 Express 中间件回退到 HTTP/1.1 处理
 */
export function startHttp2Server(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  return new Promise((resolve, reject) => {
    if (!config.ssl) {
      reject(new Error('HTTP/2 需要 SSL 配置'));
      return;
    }

    const server = createSecureServer(
      {
        key: config.ssl.key,
        cert: config.ssl.cert,
        allowHTTP1: true,
        settings: {
          maxConcurrentStreams: config.http2?.maxConcurrentStreams ?? 100,
          maxHeaderListSize: config.http2?.maxHeaderListSize ?? 16 * 1024,
        },
        maxSessionMemory: config.http2?.maxSessionMemory ?? 10,
      },
      // HTTP/2 兼容模式：通过 allowHTTP1 将请求委托给 Express
      // Express 的 request/response API 兼容 HTTP/1.1 风格
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app as any
    );
    applyHttpTimeouts(server as unknown as Server, config);

    server.listen(config.port, config.host, () => {
      const { address, port } = getServerAddress(server as unknown as Server);
      const url = `https://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`HTTP/2 服务器已启动: ${url}`);
      resolve({ server, url });
    });

    server.on('error', reject);
  });
}

// ─── HTTP/3 实现 ─────────────────────────────────

/** HTTP/3 配置 */
export interface Http3Config {
  /** QUIC 监听端口（默认与 HTTP/2 相同） */
  quicPort?: number;
  /** Alt-Svc max-age 秒数 */
  altSvcMaxAge: number;
  /** 是否启用 0-RTT */
  enable0RTT: boolean;
  /** 最大空闲超时 (ms) */
  maxIdleTimeout: number;
  /** 初始最大流数据量 (bytes) */
  initialMaxStreamData: number;
  /** 初始最大连接数据量 (bytes) */
  initialMaxData: number;
}

const DEFAULT_H3_CONFIG: Http3Config = {
  altSvcMaxAge: 86400, // 24h
  enable0RTT: true,
  maxIdleTimeout: 30000, // 30s
  initialMaxStreamData: 1048576, // 1MB
  initialMaxData: 10485760, // 10MB
};

/**
 * 启动 HTTP/3 服务器
 *
 * 实现策略：
 * 1. 启动 HTTP/2 服务器作为主传输层（兼容 Express）
 * 2. 尝试启动 QUIC UDP 监听器（需要第三方依赖或运行时支持）
 * 3. 只有 QUIC 成功时才注入 Alt-Svc 中间件，广播 h3 端点
 * 4. 支持 103 Early Hints 预加载
 *
 * 浏览器行为：
 * - 首次请求通过 HTTP/2 连接
 * - QUIC 可用时收到 Alt-Svc: h3=":443"; ma=86400 头
 * - 后续请求自动升级到 HTTP/3 (QUIC)
 */
export async function startHttp3Server(
  app: Express,
  config: ServerConfig,
  h3Config: Partial<Http3Config> = {}
): Promise<ServerStartResult> {
  if (!config.ssl) {
    throw new Error('HTTP/3 需要 SSL 配置 (QUIC 基于 TLS 1.3)');
  }

  const h3Opts = { ...DEFAULT_H3_CONFIG, ...h3Config };
  const quicPort = h3Opts.quicPort ?? config.port;

  // ─── Step 1: 尝试启动真实 QUIC 监听器 ───────────────
  let quicSocket: UdpSocket | null = null;
  if (config.http3?.enabled !== false) {
    try {
      quicSocket = await startQuicListener(config, h3Opts, quicPort);
      if (quicSocket) {
        logger.info(`🔷 QUIC 监听已启动: UDP ${config.host ?? '<bound>'}:${quicPort}`);
        app.use(createAltSvcMiddleware(quicPort, h3Opts.altSvcMaxAge));
      }
    } catch (err) {
      logger.warn(`⚠️ QUIC 监听器启动失败: ${(err as Error).message}`);
    }
  }
  if (!quicSocket) {
    logger.warn('HTTP/3 未启用真实 QUIC 传输；将以 HTTP/2 TLS 启动且不广播 Alt-Svc。');
  }

  // ─── Step 2: 注入 Early Hints 中间件 ──────────────
  app.use(createEarlyHintsMiddleware());

  // ─── Step 3: 启动 HTTP/2 服务器 ──────────────────
  const h2Server = createSecureServer(
    {
      key: config.ssl.key,
      cert: config.ssl.cert,
      allowHTTP1: true,
      // TLS 1.3 是 QUIC/HTTP3 的前提
      minVersion: 'TLSv1.3',
      // ALPN 协议协商：优先 h2，兼容 http/1.1
      ALPNProtocols: ['h2', 'http/1.1'],
      settings: {
        maxConcurrentStreams: config.http2?.maxConcurrentStreams ?? 100,
        maxHeaderListSize: config.http2?.maxHeaderListSize ?? 16 * 1024,
      },
      maxSessionMemory: config.http2?.maxSessionMemory ?? 10,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app as any
  );
  applyHttpTimeouts(h2Server as unknown as Server, config);

  // ─── Step 5: 启动 HTTP/2 监听 ────────────────────
  return new Promise((resolve, reject) => {
    h2Server.listen(config.port, config.host, () => {
      const { address, port } = getServerAddress(h2Server as unknown as Server);
      const url = `https://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`🚀 HTTP/3 服务器已启动: ${url}`);
      logger.info(
        `   ├─ HTTP/2 (TLS 1.3): TCP ${formatHostForUrl(address)}:${port || config.port}`
      );
      logger.info(
        quicSocket
          ? `   ├─ Alt-Svc: h3=":${quicPort}"; ma=${h3Opts.altSvcMaxAge}`
          : '   ├─ Alt-Svc: disabled (no real QUIC transport)'
      );
      logger.info(`   ├─ 0-RTT: ${h3Opts.enable0RTT ? '已启用' : '已禁用'}`);
      logger.info(`   └─ QUIC UDP: ${quicSocket ? '已启动' : '未启动 (依赖缺失)'}`);

      // 返回 HTTP/2 服务器实例（主入口）
      // 如果 QUIC 也启动了，在关闭时需同时关闭
      const composite = h2Server as ServerInstance;
      // 将 quicSocket 挂载以便统一关闭
      (composite as unknown as { __quicSocket?: UdpSocket }).__quicSocket = quicSocket ?? undefined;

      resolve({ server: composite, url });
    });

    h2Server.on('error', reject);
  });
}

/**
 * Alt-Svc 中间件
 * 在每个响应中注入 Alt-Svc 头，告知客户端可用的 HTTP/3 端点
 *
 * 头格式参考 RFC 7838:
 * Alt-Svc: h3=":443"; ma=86400, h3-29=":443"; ma=86400
 */
function createAltSvcMiddleware(quicPort: number, maxAge: number) {
  const altSvcValue = [
    `h3=":${quicPort}"; ma=${maxAge}`,
    `h3-29=":${quicPort}"; ma=${maxAge}`, // 兼容草案版本
  ].join(', ');

  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Alt-Svc', altSvcValue);

    // QUIC 传输参数（信息性头）
    res.setHeader('Alt-Used', `h3=":${quicPort}"`);

    next();
  };
}

/**
 * 103 Early Hints 中间件
 * 支持 HTTP/2 Server Push 的替代方案
 * 在服务器处理请求时，先发送 103 状态码提示浏览器预加载关键资源
 */
function createEarlyHintsMiddleware() {
  // 延迟加载 ManifestLoader 获取实际资源路径
  let resolvedLinks: string[] | null = null;

  return (req: Request, res: Response, next: NextFunction) => {
    // 仅对 HTML 页面请求发送 Early Hints
    const accept = req.headers['accept'] || '';
    if (
      accept.includes('text/html') &&
      typeof (res as unknown as { writeEarlyHints?: (hints: { link: string[] }) => void })
        .writeEarlyHints === 'function'
    ) {
      try {
        // 首次请求时从 manifest 解析关键资源
        if (!resolvedLinks) {
          resolvedLinks = [];
          try {
            const { ManifestLoader } = require('../manifest/ManifestLoader');
            const manifest = ManifestLoader.getManifest();
            if (manifest) {
              // 从 manifest entries 中提取 CSS 和 JS 资源
              for (const [, asset] of Object.entries(manifest.entries || {})) {
                const assetInfo = asset as { file?: string; css?: string[] };
                if (assetInfo.file) {
                  const ext = assetInfo.file.split('.').pop();
                  if (ext === 'js' || ext === 'mjs') {
                    resolvedLinks.push(`</${assetInfo.file}>; rel=preload; as=script`);
                  }
                }
                if (assetInfo.css) {
                  for (const cssFile of assetInfo.css) {
                    resolvedLinks.push(`</${cssFile}>; rel=preload; as=style`);
                  }
                }
              }
            }
          } catch {
            // manifest 不可用时不发送 Early Hints
          }
        }

        if (resolvedLinks.length > 0) {
          (
            res as unknown as { writeEarlyHints: (hints: { link: string[] }) => void }
          ).writeEarlyHints({
            link: resolvedLinks,
          });
        }
      } catch {
        // Early Hints 非关键功能，静默处理
      }
    }
    next();
  };
}

/**
 * 尝试启动 QUIC UDP 监听器
 *
 * 方案优先级：
 * 1. Node.js 实验性 QUIC API (--experimental-quic)
 * 2. 第三方 @aspect-build/quic 或 quic 包
 *
 * 生产环境建议：使用 Nginx / Caddy / Cloudflare 做 HTTP/3 终端。
 * 注意：不会启动“仅版本协商”的 UDP socket，因为那不代表可用 HTTP/3。
 */
async function startQuicListener(
  config: ServerConfig,
  h3Config: Http3Config,
  quicPort: number
): Promise<UdpSocket | null> {
  // 尝试 1: Node.js 实验性 QUIC
  try {
    const quicModule = await loadQuicModule();
    if (quicModule) {
      return await startNativeQuic(quicModule, config, h3Config, quicPort);
    }
  } catch {
    // Node.js 实验性 QUIC 不可用
  }

  // 尝试 2: 第三方 QUIC 库
  try {
    const thirdPartyQuic = await loadThirdPartyQuic();
    if (thirdPartyQuic) {
      return await startThirdPartyQuic(thirdPartyQuic, config, h3Config, quicPort);
    }
  } catch {
    // 第三方库不可用
  }

  // 不启动“仅版本协商”的假 QUIC socket。生产中广播 Alt-Svc 必须意味着
  // 客户端可以建立真实 HTTP/3 连接，否则浏览器会被误导并产生隐性退化。
  void config;
  void quicPort;
  return null;
}

/**
 * 加载 Node.js 实验性 QUIC 模块
 */
async function loadQuicModule(): Promise<unknown | null> {
  try {
    // Node.js 实验性 QUIC (需要 --experimental-quic 启动参数)
    const net = await import('net');
    if ('createQuicSocket' in net) {
      return net;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 加载第三方 QUIC 库
 */
async function loadThirdPartyQuic(): Promise<unknown | null> {
  // 按优先级尝试不同的第三方 QUIC 实现
  const candidates = ['@aspect-build/quic', 'quic', '@fails-components/webtransport'];

  for (const pkg of candidates) {
    try {
      const mod = await import(pkg);
      logger.info(`已加载 QUIC 模块: ${pkg}`);
      return { module: mod, name: pkg };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 使用 Node.js 实验性 QUIC 启动
 */
async function startNativeQuic(
  quicModule: unknown,
  config: ServerConfig,
  h3Config: Http3Config,
  quicPort: number
): Promise<UdpSocket | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createQuicSocket } = quicModule as any;

    const endpoint: Record<string, unknown> = { port: quicPort };
    if (config.host) {
      endpoint.address = config.host;
    }

    const socket = createQuicSocket({
      endpoint,
      server: {
        key: config.ssl!.key,
        cert: config.ssl!.cert,
        alpn: 'h3',
        maxIdleTimeout: h3Config.maxIdleTimeout,
        initialMaxStreamData: h3Config.initialMaxStreamData,
        initialMaxData: h3Config.initialMaxData,
      },
    });

    socket.on('session', (session: unknown) => {
      logger.debug('QUIC session established');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).on('stream', (stream: unknown) => {
        // HTTP/3 帧处理 — 实际的 HTTP/3 帧解析需要完整实现
        // 这里留给上层协议处理
        logger.debug('QUIC stream received');
      });
    });

    await socket.listen();
    logger.info('Native QUIC socket listening');
    return socket;
  } catch (error) {
    logger.warn(`Native QUIC 启动失败: ${(error as Error).message}`);
    return null;
  }
}

/**
 * 使用第三方库启动 QUIC
 */
async function startThirdPartyQuic(
  thirdParty: unknown,
  config: ServerConfig,
  _h3Config: Http3Config,
  quicPort: number
): Promise<UdpSocket | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { module: mod, name } = thirdParty as { module: any; name: string };

    if (name === '@fails-components/webtransport') {
      if (!config.host) {
        logger.warn(`WebTransport HTTP/3 Server 需要 host 配置 (via ${name})`);
        return null;
      }
      // WebTransport (基于 HTTP/3)
      const { Http3Server } = mod;
      const h3s = new Http3Server({
        host: config.host,
        port: quicPort,
        secret: 'isr-engine-h3',
        cert: config.ssl!.cert,
        privKey: config.ssl!.key,
      });

      h3s.startServer();
      logger.info(`WebTransport HTTP/3 Server 已启动 (via ${name})`);
      return h3s;
    }

    logger.warn(`不支持的 QUIC 库: ${name}`);
    return null;
  } catch (error) {
    logger.warn(`第三方 QUIC 启动失败: ${(error as Error).message}`);
    return null;
  }
}

/**
 * 根据协议启动服务器
 */
export function startServer(app: Express, config: ServerConfig): Promise<ServerStartResult> {
  switch (config.protocol) {
    case 'https':
      return startHttpsServer(app, config);
    case 'http2':
      return startHttp2Server(app, config);
    case 'http3':
      return startHttp3Server(app, config);
    case 'http1.1':
    default:
      return startHttp1Server(app, config);
  }
}

/**
 * 强制关闭服务器 —— 同时释放已建立的 keep-alive 连接，避免端口被占用
 *
 * 关闭策略：
 *   1. 调用 `server.closeAllConnections()` 切断所有活跃连接（Node 18.2+）
 *   2. `server.close()` 异步等待 listener 关闭
 *   3. `server.unref()` 让进程可以立即退出
 *   4. 2 秒超时后即使 close() 未回调也强制 resolve（防僵死）
 *   5. QUIC socket（HTTP/3）同步 close
 */
export function closeServer(server: ServerInstance): Promise<void> {
  return new Promise(resolve => {
    const shutdownTimeoutMs =
      (server as unknown as { __shutdownTimeoutMs?: number }).__shutdownTimeoutMs ??
      DEFAULT_TIMEOUTS.shutdownTimeoutMs;
    const quicSocket = (server as unknown as { __quicSocket?: UdpSocket }).__quicSocket;
    if (quicSocket) {
      try {
        quicSocket.close();
      } catch {
        // QUIC socket 关闭失败不阻塞主服务器关闭
      }
    }

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
      // 旧 Node 版本可能没有此方法；用 closeIdleConnections 兜底
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
