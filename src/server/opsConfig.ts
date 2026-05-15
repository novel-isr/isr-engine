import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ISRConfig } from '@/types';

type OpsEndpointName = 'health' | 'metrics' | 'inventory';

export interface ResolvedOpsEndpointConfig {
  enabled: boolean;
  public: boolean;
}

export interface ResolvedOpsConfig {
  authToken?: string;
  tokenHeader: string;
  health: ResolvedOpsEndpointConfig;
  metrics: ResolvedOpsEndpointConfig;
  inventory: ResolvedOpsEndpointConfig;
  warnings: string[];
}

const OPS_ENDPOINT_PATHS: Record<OpsEndpointName, string> = {
  health: '/health',
  metrics: '/metrics',
  inventory: '/__isr/cache/inventory',
};

const DEFAULT_TOKEN_HEADER = 'x-isr-admin-token';

const DEV_DEFAULTS: Record<OpsEndpointName, ResolvedOpsEndpointConfig> = {
  health: { enabled: true, public: true },
  metrics: { enabled: true, public: true },
  // dev 默认开放 inventory，方便本地排错；public=true 让 curl 不带 token 也能用
  inventory: { enabled: true, public: true },
};

const PROD_DEFAULTS: Record<OpsEndpointName, ResolvedOpsEndpointConfig> = {
  health: { enabled: true, public: true },
  metrics: { enabled: false, public: false },
  // 生产默认上线 + 强制 token —— 故障诊断工具事故来时才用，不能临时部署再开
  // （等 deploy 完缓存现场已经变了）。安全靠 server.ops.authToken 锁住，不靠 disabled。
  // 没配 token 时 resolveEndpointConfig 自动 disable + 出 warning，行为同 metrics。
  inventory: { enabled: true, public: false },
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEndpointConfig(
  endpoint: OpsEndpointName,
  input: { enabled?: boolean; public?: boolean } | undefined,
  defaults: ResolvedOpsEndpointConfig,
  env: 'development' | 'production',
  authToken: string | undefined,
  warnings: string[]
): ResolvedOpsEndpointConfig {
  const enabled = input?.enabled ?? defaults.enabled;
  const isPublic = input?.public ?? defaults.public;

  if (!enabled) {
    return { enabled: false, public: isPublic };
  }

  if (env === 'production' && endpoint !== 'health') {
    const path = OPS_ENDPOINT_PATHS[endpoint];
    if (isPublic) {
      warnings.push(`生产环境公开暴露 ${path}，请确认只在内网或受上游 ACL 保护时使用。`);
    } else if (!authToken) {
      warnings.push(`生产环境启用 ${path} 但未配置 server.ops.authToken，已自动关闭该端点。`);
      return { enabled: false, public: false };
    }
  }

  return { enabled: true, public: isPublic };
}

export function resolveOpsConfig(
  config: Partial<ISRConfig> | undefined,
  env: 'development' | 'production'
): ResolvedOpsConfig {
  const ops = config?.server?.ops;
  const defaults = env === 'production' ? PROD_DEFAULTS : DEV_DEFAULTS;
  const warnings: string[] = [];
  const authToken = trimToUndefined(ops?.authToken);

  return {
    authToken,
    tokenHeader: trimToUndefined(ops?.tokenHeader) ?? DEFAULT_TOKEN_HEADER,
    health: resolveEndpointConfig('health', ops?.health, defaults.health, env, authToken, warnings),
    metrics: resolveEndpointConfig(
      'metrics',
      ops?.metrics,
      defaults.metrics,
      env,
      authToken,
      warnings
    ),
    inventory: resolveEndpointConfig(
      'inventory',
      ops?.inventory,
      defaults.inventory,
      env,
      authToken,
      warnings
    ),
    warnings,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(
  res: {
    statusCode?: number;
    setHeader?: (name: string, value: string) => void;
    end?: (body: string) => void;
    status?: (code: number) => unknown;
    json?: (body: unknown) => unknown;
  },
  statusCode: number,
  body: unknown
): void {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(statusCode);
    res.json(body);
    return;
  }

  res.statusCode = statusCode;
  res.setHeader?.('content-type', 'application/json; charset=utf-8');
  res.end?.(JSON.stringify(body));
}

function readOpsToken(
  req: { headers: Record<string, string | string[] | undefined> },
  tokenHeader: string
): string | undefined {
  const headerValue = req.headers[tokenHeader] ?? req.headers[tokenHeader.toLowerCase()];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  const authValue = req.headers.authorization;
  if (typeof authValue === 'string') {
    const match = authValue.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

export function createOpsAuthMiddleware(
  endpoint: 'metrics' | 'inventory',
  resolved: ResolvedOpsConfig
): RequestHandler {
  const policy = resolved[endpoint];
  if (!policy.enabled || policy.public) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const token = readOpsToken(
      req as unknown as { headers: Record<string, string | string[] | undefined> },
      resolved.tokenHeader
    );

    if (!token) {
      sendJson(res, 401, {
        error: 'Ops token required',
        header: resolved.tokenHeader,
      });
      return;
    }

    if (!resolved.authToken || !safeEqual(token, resolved.authToken)) {
      sendJson(res, 403, { error: 'Invalid ops token' });
      return;
    }

    next();
  };
}
