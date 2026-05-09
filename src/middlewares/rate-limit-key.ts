/**
 * Rate-limit key 生成 —— engine 内部模块，不再对外导出。
 *
 * 历史：之前给 ssr.config.ts 暴露过 './rate-limit-key' sub-entry 让业务侧
 * `import { createUserAwareKeyGenerator }` —— 这种"传函数当配置"的设计有 3 个问题：
 *   1. 业务侧 import engine 内部细节，把封装边界打破
 *   2. trustProxy 在工厂参数里写一遍 + 在 rateLimit.trustProxy 又写一遍，重复
 *   3. ssr.config.ts 含 function 引用，序列化 / 缓存 hash / snapshot 全部出问题
 *
 * 现在：业务侧只声明数据（cookie 名 + 字段名），engine 内部自己装配 keyGenerator。
 * 详见 RuntimeRateLimitConfig.userBucket。
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

/** UserBucket 配置 —— 数据驱动的"已登录用户"维度 */
export interface UserBucketConfig {
  /**
   * Cookie 名 —— 通常是 sessionUser JSON cookie（业务侧写的）。
   * cookie 值期望是 `JSON.stringify({ userId, ... })` 形态。
   */
  cookie?: string;
  /** JSON 里的 userId 字段名，默认 'userId' */
  field?: string;
  /**
   * Header 名 —— 通常是上游 gateway / BFF 解 JWT 后注入的（例：'x-user-id'）。
   * trustProxy=false 时不会读这条头（客户端可伪造）。
   */
  header?: string;
}

/** 内部 keyGenerator 装配选项 */
export interface BuildKeyGeneratorOptions {
  /** 跟 rate-limit middleware 主配置共用的 trustProxy；不再单独传一遍 */
  trustProxy: boolean;
  /** 已登录用户维度配置；为空 → 仅按 IP 分桶 */
  userBucket?: UserBucketConfig;
  /**
   * 给桶 key 加多租户前缀（`t:<tenantId>:`），从 `x-tenant-id` 头读取。
   * 仅 trustProxy=true 时生效（gateway 已校验 tenantId 后注入）；否则忽略。
   * 单租户站点设 false，避免每个 key 都多余的 `t:public:` 前缀噪音。
   */
  useTenantPrefix?: boolean;
  /**
   * 给桶 key 加 segment 前缀（`s:<segment>:`），从 `x-segment` 头读取。
   * 让 'premium' / 'free' 等不同 segment 独立 quota（admin 控制面可分别配阈值）。
   * 仅 trustProxy=true 时生效（gateway / BFF 决策后注入）。
   */
  useSegmentPrefix?: boolean;
}

const TENANT_HEADER = 'x-tenant-id';
const SEGMENT_HEADER = 'x-segment';

function readSingleHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
}

/**
 * 业界通用模式（Cloudflare / Stripe / GitHub API）：已登录走 user，未登录走 IP。
 * 防 NAT / 公司网 / mobile carrier 后面成千上万用户共享同一个出口 IP，被某个高频
 * 用户打爆。
 *
 * 桶 key 形态（按上面 options 决定加什么前缀）：
 *   - 最简：             `u:<userId>` 或 `ip:<addr>`
 *   - 多租户：           `t:<tenantId>:u:<userId>`
 *   - 多 segment：       `s:premium:u:<userId>`
 *   - 全开：             `t:<tenantId>:s:premium:u:<userId>`
 */
export function buildKeyGenerator(options: BuildKeyGeneratorOptions): (req: Request) => string {
  const { trustProxy, userBucket, useTenantPrefix, useSegmentPrefix } = options;
  const cookie = userBucket?.cookie;
  const field = userBucket?.field ?? 'userId';
  const headerLower = userBucket?.header?.toLowerCase();

  const extractUserId = (req: Request): string | null => {
    if (headerLower && trustProxy) {
      const raw = req.headers[headerLower];
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    if (cookie) {
      const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
      const cookies = parseCookieHeader(cookieHeader);
      const raw = cookies[cookie];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const id = parsed?.[field];
          if (typeof id === 'string' && id.trim()) return id.trim();
        } catch {
          // cookie 不是 JSON —— 落到 IP 兜底
        }
      }
    }
    return null;
  };

  return (req: Request): string => {
    const parts: string[] = [];
    if (useTenantPrefix && trustProxy) {
      const tenant = readSingleHeader(req, TENANT_HEADER);
      if (tenant) parts.push(`t:${tenant}`);
    }
    if (useSegmentPrefix && trustProxy) {
      const segment = readSingleHeader(req, SEGMENT_HEADER);
      if (segment) parts.push(`s:${segment}`);
    }

    const userId = extractUserId(req);
    parts.push(userId ? `u:${userId}` : `ip:${extractClientIp(req, trustProxy)}`);
    return parts.join(':');
  };
}
