/**
 * Rate-limit key 生成 —— engine 内部模块，不对外导出。
 *
 * 业务侧在 ssr.config.ts 声明数据（`userBucket: { cookie, field }` + `trustProxy`），
 * engine 内部装配 keyGenerator；ssr.config.ts 不含 function 引用，配置可序列化 / 哈希。
 */
import type { Request } from 'express';
import { parseCookieHeader } from '../utils/cookie';

/**
 * 从请求中提取"真实客户端 IP"。
 *
 * 信任语义（任意 truthy 值都信任代理头；hop count > 0 跟 boolean true 走同一条路径）：
 *   1) CF-Connecting-IP —— Cloudflare 的权威头，不可伪造
 *   2) X-Real-IP        —— Nginx realip 模块 / 内网 LB 常用
 *   3) X-Forwarded-For  —— RFC 7239 标准，取最左一跳（原始客户端）
 *   4) req.ip           —— Express 按 trust proxy 跳数解析后的 IP
 *
 * 不信任（false / 0）时只用 req.ip，保证直连公网场景不会被伪造头欺骗。
 *
 * trustProxy 是数字时由 cli/start.ts 把跳数透传给 `app.set('trust proxy', N)`，
 * Express 内部 req.ip 解析自动跟着走（这里只关心"信不信"二元）。
 */
export function extractClientIp(req: Request, trustProxy: boolean | number): string {
  const trust = trustProxy === true || (typeof trustProxy === 'number' && trustProxy > 0);
  if (trust) {
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
  trustProxy: boolean | number;
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
