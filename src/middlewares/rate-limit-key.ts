/**
 * Rate-limit key 生成 —— engine 内部模块，不对外导出。
 *
 * 历史包袱：之前给 ssr.config.ts 暴露过 './rate-limit-key' sub-entry，让业务侧 import
 * `createUserAwareKeyGenerator` 这个工厂函数 —— 三个问题：
 *   1. 暴露 engine 内部细节，破坏封装
 *   2. trustProxy 在工厂参数 + rateLimit 主配置各写一遍，重复
 *   3. ssr.config.ts 含 function 引用，序列化 / 缓存 hash / snapshot 全部出问题
 *
 * 现在：业务侧只声明 `userBucket: { cookie, field }` 数据，engine 内部装配 keyGenerator。
 *
 * 多租户 / 多 segment 维度（之前的 useTenantPrefix / useSegmentPrefix）已删除：
 * novel-rating 单租户场景永远用不到，YAGNI。SaaS 真有需要时再加，加之前 buildKeyGenerator
 * 仍可扩展（这个内部函数本来就是为未来增维度而设计的简洁结构）。
 */
import type { Request } from 'express';
import { parseCookieHeader } from '../utils/cookie';

/**
 * 从请求中提取"真实客户端 IP"。
 *
 * 优先级（仅在 trustProxy=true 时应用）：
 *   1) CF-Connecting-IP —— Cloudflare 的权威头，不可伪造
 *   2) X-Real-IP        —— Nginx realip 模块 / 内网 LB 常用
 *   3) X-Forwarded-For  —— RFC 7239 标准，取最左一跳（原始客户端）
 *   4) req.ip           —— Express 解析后的 socket IP（需 trust proxy 配置）
 *
 * trustProxy=false 时只用 req.ip，保证 Internet 直连场景不会被伪造头欺骗。
 */
export function extractClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return Array.isArray(cf) ? cf[0] : String(cf).trim();
    const real = req.headers['x-real-ip'];
    if (real) return Array.isArray(real) ? real[0] : String(real).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : String(xff);
      return raw.split(',')[0].trim();
    }
  }
  return req.ip ?? 'unknown';
}

/** UserBucket 配置 —— 数据驱动的"已登录用户"维度（cookie 名是每个 app 的 auth 后端决定） */
export interface UserBucketConfig {
  /**
   * Cookie 名 —— 通常是 sessionUser JSON cookie（业务侧 auth 后端写的）。
   * cookie 值期望是 `JSON.stringify({ userId, ... })` 形态。
   */
  cookie: string;
  /** JSON 里的 userId 字段名 */
  field: string;
}

/** 内部 keyGenerator 装配选项 */
export interface BuildKeyGeneratorOptions {
  /** 跟 rate-limit middleware 主配置共用的 trustProxy；不再单独传一遍 */
  trustProxy: boolean;
  /** 已登录用户维度配置；undefined → 仅按 IP 分桶（anonymous-only 站点） */
  userBucket: UserBucketConfig | undefined;
}

/**
 * 业界通用模式（Cloudflare / Stripe / GitHub API）：已登录走 user，未登录走 IP。
 * 防 NAT / 公司网 / mobile carrier 后面成千用户共享一个出口 IP，被某高频用户挤爆。
 *
 * 桶 key：
 *   - 已登录：`u:<userId>`
 *   - 未登录 / userBucket=undefined：`ip:<addr>`
 */
export function buildKeyGenerator(options: BuildKeyGeneratorOptions): (req: Request) => string {
  const { trustProxy, userBucket } = options;

  const extractUserId = (req: Request): string | null => {
    if (!userBucket) return null;
    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    const cookies = parseCookieHeader(cookieHeader);
    const raw = cookies[userBucket.cookie];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const id = parsed?.[userBucket.field];
      if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
      // cookie 不是 JSON —— 落到 IP 兜底
    }
    return null;
  };

  return (req: Request): string => {
    const userId = extractUserId(req);
    return userId ? `u:${userId}` : `ip:${extractClientIp(req, trustProxy)}`;
  };
}
