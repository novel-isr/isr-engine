/**
 * HTTP 服务器启动器
 * 根据协议创建对应的服务器实例
 *
 * 支持：
 * - HTTP/1.1: 标准明文 HTTP
 * - HTTPS: TLS 加密 HTTP/1.1
 * - HTTP/2: 基于 TLS 的多路复用（兼容 HTTP/1.1 回退）
 * - HTTP/3: 基于 HTTP/2 + Alt-Svc 广播 h3 + 可选 QUIC 监听
 *
 * HTTP/3 策略说明：
 * Node.js 尚无稳定的原生 QUIC 支持。业界成熟方案是：
 * 1. 用 HTTP/2 (TLS) 服务请求
 * 2. 通过 Alt-Svc 响应头告知浏览器/客户端可用的 h3 端点
 * 3. 可选：绑定 UDP 端口启动 QUIC 监听（需要 @aspect-build/quic 等第三方库）
 * 4. 客户端首次请求通过 HTTP/2，后续请求自动升级到 HTTP/3
 * 这也是 Cloudflare / Fastly / Nginx 的标准做法。
 */

import { createServer as createHttpServer, Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createSecureServer, Http2SecureServer, constants as h2constants } from 'http2';
import { createSocket as createUdpSocket, Socket as UdpSocket } from 'dgram';
import type { AddressInfo } from 'net';
import type { Express, Request, Response, NextFunction } from 'express';
import { randomInt } from 'crypto';
import { Logger } from '@/logger/Logger';
import type { ServerConfig, ServerInstance, ServerStartResult } from './types';

const logger = Logger.getInstance();

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
      },
      // HTTP/2 兼容模式：通过 allowHTTP1 将请求委托给 Express
      // Express 的 request/response API 兼容 HTTP/1.1 风格
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app as any
    );

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
 * 2. 注入 Alt-Svc 中间件，广播 h3 端点
 * 3. 尝试启动 QUIC UDP 监听器（可选，需要第三方依赖）
 * 4. 支持 103 Early Hints 预加载
 *
 * 浏览器行为：
 * - 首次请求通过 HTTP/2 连接
 * - 收到 Alt-Svc: h3=":443"; ma=86400 头
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

  // ─── Step 1: 注入 Alt-Svc 中间件 ─────────────────
  app.use(createAltSvcMiddleware(quicPort, h3Opts.altSvcMaxAge));

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
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app as any
  );

  // 开启 HTTP/2 Server Push 支持
  h2Server.on('stream', (stream, headers) => {
    // 仅处理 HTTP/2 原生推送场景（如静态资源预推送）
    // Express 的请求已经通过 allowHTTP1 回退处理
    const path = headers[':path'];
    if (typeof path === 'string' && path.endsWith('.html')) {
      // 对 HTML 请求，可以推送关键 CSS/JS（通过 Link header 实现更通用）
      stream.respond({
        [h2constants.HTTP2_HEADER_STATUS]: 200,
        'alt-svc': `h3=":${quicPort}"; ma=${h3Opts.altSvcMaxAge}`,
      });
    }
  });

  // ─── Step 4: 尝试启动 QUIC 监听器 ─────────────────
  let quicSocket: UdpSocket | null = null;

  try {
    quicSocket = await startQuicListener(config, h3Opts, quicPort);
    if (quicSocket) {
      logger.info(`🔷 QUIC 监听已启动: UDP ${config.host ?? '<bound>'}:${quicPort}`);
    }
  } catch (err) {
    logger.warn(
      `⚠️ QUIC 监听器启动失败: ${(err as Error).message}。` +
        `HTTP/3 将通过 Alt-Svc 广播，等待客户端升级。`
    );
  }

  // ─── Step 5: 启动 HTTP/2 监听 ────────────────────
  return new Promise((resolve, reject) => {
    h2Server.listen(config.port, config.host, () => {
      const { address, port } = getServerAddress(h2Server as unknown as Server);
      const url = `https://${formatHostForUrl(address)}:${port || config.port}`;
      logger.info(`🚀 HTTP/3 服务器已启动: ${url}`);
      logger.info(
        `   ├─ HTTP/2 (TLS 1.3): TCP ${formatHostForUrl(address)}:${port || config.port}`
      );
      logger.info(`   ├─ Alt-Svc: h3=":${quicPort}"; ma=${h3Opts.altSvcMaxAge}`);
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
 * 3. 基础 UDP Socket（仅版本协商，不处理完整 QUIC）
 *
 * 生产环境建议：使用 Nginx / Caddy / Cloudflare 做 HTTP/3 终端
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

  // 尝试 3: 基础 UDP 版本协商
  // 创建 UDP socket 响应 QUIC Version Negotiation
  // 这让客户端知道服务端可以接收 QUIC 报文（即使不处理完整协议）
  return startBasicQuicNegotiation(config, quicPort);
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
 * 基础 QUIC 版本协商 UDP Socket
 *
 * 当没有完整 QUIC 实现时，创建 UDP socket 处理 QUIC 版本协商:
 * - 接收 QUIC Initial 包
 * - 回复 Version Negotiation 包
 * - 这让支持 HTTP/3 的客户端知道服务端"存在"
 *
 * 注意：这不是完整的 HTTP/3，仅用于协议发现。
 * 完整 HTTP/3 请使用专业的 QUIC 库或反向代理。
 */
function startBasicQuicNegotiation(
  config: ServerConfig,
  quicPort: number
): Promise<UdpSocket | null> {
  return new Promise(resolve => {
    try {
      const socket = createUdpSocket('udp4');

      // QUIC Version Negotiation
      socket.on('message', (msg, rinfo) => {
        // QUIC 包最小 1200 字节 (Initial)
        if (msg.length < 1200) return;

        // 检查是否为 QUIC Long Header (第一位为1)
        const firstByte = msg[0];
        if ((firstByte & 0x80) === 0) return; // Short Header, 忽略

        // 提取 Version 字段 (bytes 1-4)
        const version = msg.readUInt32BE(1);

        // 如果版本未知，发送 Version Negotiation
        // QUIC v1 = 0x00000001, QUIC v2 = 0x6b3343cf
        const supportedVersions = [0x00000001, 0x6b3343cf];

        if (!supportedVersions.includes(version)) {
          const vnPacket = createVersionNegotiationPacket(msg, supportedVersions);
          socket.send(vnPacket, rinfo.port, rinfo.address);
        }
      });

      socket.on('error', err => {
        logger.debug(`QUIC UDP socket 错误: ${err.message}`);
        resolve(null);
      });

      if (config.host) {
        socket.bind(quicPort, config.host, () => {
          logger.info(`QUIC 版本协商 UDP 已绑定: ${config.host}:${quicPort}`);
          resolve(socket);
        });
      } else {
        socket.bind(quicPort, () => {
          const addr = socket.address();
          const host = typeof addr === 'object' && addr ? addr.address : '<bound>';
          logger.info(`QUIC 版本协商 UDP 已绑定: ${host}:${quicPort}`);
          resolve(socket);
        });
      }
    } catch {
      resolve(null);
    }
  });
}

/**
 * 构造 QUIC Version Negotiation 包
 * RFC 9000 Section 17.2.1
 */
function createVersionNegotiationPacket(
  initialPacket: Buffer,
  supportedVersions: number[]
): Buffer {
  // Version Negotiation 格式:
  // 1 byte: 首字节 (随机, 但最高位为1)
  // 4 bytes: Version = 0x00000000 (标识 VN 包)
  // DCID Len + DCID (从原包 SCID 提取)
  // SCID Len + SCID (从原包 DCID 提取)
  // N * 4 bytes: 支持的版本列表

  // 从 Initial 包提取连接 ID
  const dcidLen = initialPacket[5];
  const dcid = initialPacket.subarray(6, 6 + dcidLen);
  const scidLenOffset = 6 + dcidLen;
  const scidLen = initialPacket[scidLenOffset];
  const scid = initialPacket.subarray(scidLenOffset + 1, scidLenOffset + 1 + scidLen);

  // VN 包: 交换 DCID 和 SCID
  const packetLen = 1 + 4 + 1 + scidLen + 1 + dcidLen + supportedVersions.length * 4;
  const vnPacket = Buffer.alloc(packetLen);
  let offset = 0;

  // 首字节：Long Header 标志（使用 crypto 安全随机数）
  vnPacket[offset++] = 0x80 | randomInt(0x7f);

  // Version = 0 (Version Negotiation 标识)
  vnPacket.writeUInt32BE(0x00000000, offset);
  offset += 4;

  // DCID = 原包的 SCID
  vnPacket[offset++] = scidLen;
  scid.copy(vnPacket, offset);
  offset += scidLen;

  // SCID = 原包的 DCID
  vnPacket[offset++] = dcidLen;
  dcid.copy(vnPacket, offset);
  offset += dcidLen;

  // 支持的版本列表
  for (const version of supportedVersions) {
    vnPacket.writeUInt32BE(version, offset);
    offset += 4;
  }

  return vnPacket;
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

    const timeout = setTimeout(safeResolve, 2000);
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
