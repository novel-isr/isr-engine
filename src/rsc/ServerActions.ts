/**
 * Server Actions —— engine 级元数据注册
 *
 * 架构分工（方案 A 后）：
 *   - 协议传输：`@vitejs/plugin-rsc` 负责 encodeReply/decodeReply、loadServerAction、
 *     Server Action 的 POST 路由、multipart 解码、响应 Flight 流等全部协议层工作
 *   - 本模块职责：仅做元数据层面的注册表，供 engine 的调试 / 指标 / 管理面板使用
 *
 * 编写注意：
 *   - 不重复实现执行/传输/序列化逻辑 —— 全部交给 plugin
 *   - `createServerAction` 仅为便利 API：在 registry 中登记元数据，返回原函数
 *     （不再伪造 `$$typeof`/`$$id` —— 这些由 plugin 的 transforms 在编译时注入到
 *     `'use server'` 声明的模块导出上）
 */

import { Logger } from '../logger/Logger';

const logger = Logger.getInstance();

export interface ServerActionMetadata {
  /** Action ID（应与 plugin 生成的 reference id 保持一致；自行注册时由调用方提供） */
  id: string;
  name: string;
  module?: string;
  line?: number;
  file?: string;
}

export type ServerActionHandler = (...args: unknown[]) => Promise<unknown> | unknown;

class ServerActionsRegistry {
  private readonly metadata = new Map<string, ServerActionMetadata>();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('✅ Server Actions Registry 已初始化');
  }

  async cleanup(): Promise<void> {
    this.metadata.clear();
    this.initialized = false;
    logger.info('✅ Server Actions Registry 已清理');
  }

  register(id: string, metadata: Omit<ServerActionMetadata, 'id'>): string {
    this.metadata.set(id, { id, ...metadata });
    return id;
  }

  getAllActions(): ServerActionMetadata[] {
    return Array.from(this.metadata.values());
  }

  hasAction(actionId: string): boolean {
    return this.metadata.has(actionId);
  }

  getMetadata(actionId: string): ServerActionMetadata | undefined {
    return this.metadata.get(actionId);
  }
}

export const serverActionsRegistry = new ServerActionsRegistry();

/**
 * 声明式注册：用于在服务端日志/管理面板中登记一个 action 的元数据
 *
 * 运行时执行请使用 `'use server'` 指令；本函数**不**改变执行语义，仅记录元数据
 */
export function createServerAction<T extends ServerActionHandler>(
  handler: T,
  metadata: Omit<ServerActionMetadata, 'id'> & { id: string }
): T {
  serverActionsRegistry.register(metadata.id, metadata);
  return handler;
}

export const ServerActionUtils = {
  isServer(): boolean {
    return typeof window === 'undefined';
  },
  isClient(): boolean {
    return typeof window !== 'undefined';
  },
  getExecutionContext() {
    if (this.isServer()) {
      return {
        environment: 'server' as const,
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd(),
      };
    }
    return {
      environment: 'client' as const,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      timestamp: new Date().toISOString(),
    };
  },
};
