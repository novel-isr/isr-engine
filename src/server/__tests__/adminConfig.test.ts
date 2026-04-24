import { describe, expect, it, vi } from 'vitest';
import { createAdminAuthMiddleware, resolveAdminConfig } from '../adminConfig';

describe('resolveAdminConfig', () => {
  it('production 默认只公开 health', () => {
    const resolved = resolveAdminConfig({}, 'production');
    expect(resolved.health.enabled).toBe(true);
    expect(resolved.health.public).toBe(true);
    expect(resolved.stats.enabled).toBe(false);
    expect(resolved.clear.enabled).toBe(false);
    expect(resolved.metrics.enabled).toBe(false);
  });

  it('production 未配置 authToken 时自动关闭受保护端点', () => {
    const resolved = resolveAdminConfig(
      {
        server: {
          port: 3000,
          admin: {
            stats: { enabled: true },
          },
        },
      },
      'production'
    );

    expect(resolved.stats.enabled).toBe(false);
    expect(resolved.warnings[0]).toContain('/__isr/stats');
  });

  it('production 显式 public 会保留并打印 warning', () => {
    const resolved = resolveAdminConfig(
      {
        server: {
          port: 3000,
          admin: {
            metrics: { enabled: true, public: true },
          },
        },
      },
      'production'
    );

    expect(resolved.metrics.enabled).toBe(true);
    expect(resolved.metrics.public).toBe(true);
    expect(resolved.warnings[0]).toContain('/metrics');
  });
});

describe('createAdminAuthMiddleware', () => {
  it('允许 Bearer token 访问受保护端点', () => {
    const resolved = resolveAdminConfig(
      {
        server: {
          port: 3000,
          admin: {
            authToken: 'secret-token',
            stats: { enabled: true, public: false },
          },
        },
      },
      'production'
    );
    const middleware = createAdminAuthMiddleware('stats', resolved);
    const next = vi.fn();
    const req = {
      headers: {
        authorization: 'Bearer secret-token',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('缺失 token 时返回 401', () => {
    const resolved = resolveAdminConfig(
      {
        server: {
          port: 3000,
          admin: {
            authToken: 'secret-token',
            clear: { enabled: true, public: false },
          },
        },
      },
      'production'
    );
    const middleware = createAdminAuthMiddleware('clear', resolved);
    const next = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    middleware({ headers: {} } as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
