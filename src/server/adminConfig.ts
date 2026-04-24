import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ISRConfig } from '@/types';

type AdminEndpointName = 'health' | 'stats' | 'clear' | 'metrics';

export interface ResolvedAdminEndpointConfig {
  enabled: boolean;
  public: boolean;
}

export interface ResolvedAdminConfig {
  authToken?: string;
  tokenHeader: string;
  health: ResolvedAdminEndpointConfig;
  stats: ResolvedAdminEndpointConfig;
  clear: ResolvedAdminEndpointConfig;
  metrics: ResolvedAdminEndpointConfig;
  warnings: string[];
}

const ADMIN_ENDPOINT_PATHS: Record<AdminEndpointName, string> = {
  health: '/health',
  stats: '/__isr/stats',
  clear: '/__isr/clear',
  metrics: '/metrics',
};

const DEFAULT_TOKEN_HEADER = 'x-isr-admin-token';

const DEV_DEFAULTS: Record<AdminEndpointName, ResolvedAdminEndpointConfig> = {
  health: { enabled: true, public: true },
  stats: { enabled: true, public: true },
  clear: { enabled: true, public: true },
  metrics: { enabled: true, public: true },
};

const PROD_DEFAULTS: Record<AdminEndpointName, ResolvedAdminEndpointConfig> = {
  health: { enabled: true, public: true },
  stats: { enabled: false, public: false },
  clear: { enabled: false, public: false },
  metrics: { enabled: false, public: false },
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEndpointConfig(
  endpoint: AdminEndpointName,
  input: { enabled?: boolean; public?: boolean } | undefined,
  defaults: ResolvedAdminEndpointConfig,
  env: 'development' | 'production',
  authToken: string | undefined,
  warnings: string[]
): ResolvedAdminEndpointConfig {
  const enabled = input?.enabled ?? defaults.enabled;
  const isPublic = input?.public ?? defaults.public;

  if (!enabled) {
    return { enabled: false, public: isPublic };
  }

  if (env === 'production' && endpoint !== 'health') {
    const path = ADMIN_ENDPOINT_PATHS[endpoint];
    if (isPublic) {
      warnings.push(`生产环境公开暴露 ${path}，请确认只在内网或受上游 ACL 保护时使用。`);
    } else if (!authToken) {
      warnings.push(`生产环境启用 ${path} 但未配置 server.admin.authToken，已自动关闭该端点。`);
      return { enabled: false, public: false };
    }
  }

  return { enabled: true, public: isPublic };
}

export function resolveAdminConfig(
  config: Partial<ISRConfig> | undefined,
  env: 'development' | 'production'
): ResolvedAdminConfig {
  const admin = config?.server?.admin;
  const defaults = env === 'production' ? PROD_DEFAULTS : DEV_DEFAULTS;
  const warnings: string[] = [];
  const authToken = trimToUndefined(admin?.authToken);

  return {
    authToken,
    tokenHeader: trimToUndefined(admin?.tokenHeader) ?? DEFAULT_TOKEN_HEADER,
    health: resolveEndpointConfig(
      'health',
      admin?.health,
      defaults.health,
      env,
      authToken,
      warnings
    ),
    stats: resolveEndpointConfig('stats', admin?.stats, defaults.stats, env, authToken, warnings),
    clear: resolveEndpointConfig('clear', admin?.clear, defaults.clear, env, authToken, warnings),
    metrics: resolveEndpointConfig(
      'metrics',
      admin?.metrics,
      defaults.metrics,
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

function readAdminToken(
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

export function createAdminAuthMiddleware(
  endpoint: Exclude<AdminEndpointName, 'health'>,
  resolved: ResolvedAdminConfig
): RequestHandler {
  const policy = resolved[endpoint];
  if (!policy.enabled || policy.public) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const token = readAdminToken(
      req as unknown as { headers: Record<string, string | string[] | undefined> },
      resolved.tokenHeader
    );

    if (!token) {
      sendJson(res, 401, {
        error: 'Admin token required',
        header: resolved.tokenHeader,
      });
      return;
    }

    if (!resolved.authToken || !safeEqual(token, resolved.authToken)) {
      sendJson(res, 403, { error: 'Invalid admin token' });
      return;
    }

    next();
  };
}
