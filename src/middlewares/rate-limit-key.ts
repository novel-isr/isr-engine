/**
 * Rate-limit key 生成 —— 纯函数 + Express Request 类型，无任何重依赖。
 *
 * 单独成文件是为了给 ssr.config.ts 提供一个超轻量的入口（@novel-isr/engine/rate-limit-key），
 * 跟 ./config 一样的"消费方 vite 不会被牵连进 CLI / SSG / esbuild"原则
 * （详见 isr-engine vite.config.ts 顶部那段注释）。
 *
 * 业务侧用法：
 *
 *   // novel-rating ssr.config.ts
 *   import { createUserAwareKeyGenerator } from '@novel-isr/engine/rate-limit-key';
 *
 *   rateLimit: {
 *     keyGenerator: createUserAwareKeyGenerator({
 *       userIdCookie: 'novel_session_user',
 *       userIdField: 'userId',
 *       trustProxy: false,
 *     }),
 *   }
 *
 * 完整 RateLimiter 中间件 / Redis store 在 './RateLimiter'，由 engine 内部的
 * cli/start.ts + server/manager.ts 装配，不需要业务侧直接引。
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

/**
 * 用户感知的 rate-limit key 生成 ——
 *
 * 跟 Cloudflare / Stripe / GitHub API 一致的"已登录走 user，未登录走 IP"模式。
 * 防止 NAT / 公司网 / 移动 carrier 后面成千用户共享一个 IP，被某一个频繁请求
 * 的用户挤爆所有人的桶。
 *
 * 优先级（高 → 低）：
 *   1. userIdHeader 命中（trusted gateway 解了 JWT 后写在头里）   → `u:<id>`
 *   2. userIdCookie 解 JSON、读 userIdField 命中（cookie-based session）→ `u:<id>`
 *   3. IP 兜底（未登录访客 / 爬虫）                                 → `ip:<addr>`
 *
 * key 加 `u:` / `ip:` 前缀可以让 ops dashboard 一眼区分用户桶 vs IP 桶
 * （admin /operations/rate-limit 面板会按前缀分组统计）。
 */
export interface CreateUserAwareKeyGeneratorOptions {
  /**
   * Cookie 名 —— 通常是 sessionUser JSON cookie（业务侧写的）。
   * cookie 值期望是 `JSON.stringify({ userId, ... })` 形态。
   */
  userIdCookie?: string;
  /** JSON 里的 userId 字段名，默认 'userId' */
  userIdField?: string;
  /**
   * Header 名 —— 通常是上游 gateway / BFF 解 JWT 后注入的。
   * 例：`x-user-id`。trustProxy=false 时不要用这条（客户端可伪造）。
   */
  userIdHeader?: string;
  /** 跟 extractClientIp 共用同一个 trustProxy 标志位 */
  trustProxy?: boolean;
}

export function createUserAwareKeyGenerator(
  options: CreateUserAwareKeyGeneratorOptions = {}
): (req: Request) => string {
  const { userIdCookie, userIdField = 'userId', userIdHeader, trustProxy = false } = options;
  const headerLower = userIdHeader?.toLowerCase();

  return (req: Request): string => {
    if (headerLower) {
      const raw = req.headers[headerLower];
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed) return `u:${trimmed}`;
      }
    }

    if (userIdCookie) {
      const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
      const cookies = parseCookieHeader(cookieHeader);
      const raw = cookies[userIdCookie];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const id = parsed?.[userIdField];
          if (typeof id === 'string') {
            const trimmed = id.trim();
            if (trimmed) return `u:${trimmed}`;
          }
        } catch {
          // cookie 不是 JSON —— 不当 userId 用，落到 IP 兜底
        }
      }
    }

    return `ip:${extractClientIp(req, trustProxy)}`;
  };
}
