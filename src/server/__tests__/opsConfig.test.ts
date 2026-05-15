import { describe, expect, it, vi } from 'vitest';
import { createOpsAuthMiddleware, resolveOpsConfig } from '../opsConfig';

type PartialOpsConfig = {
  authToken?: string;
  tokenHeader?: string;
  health?: { enabled?: boolean; public?: boolean };
  metrics?: { enabled?: boolean; public?: boolean };
  inventory?: { enabled?: boolean; public?: boolean };
};

function serverOpsConfig(
  ops: PartialOpsConfig
): NonNullable<Parameters<typeof resolveOpsConfig>[0]> {
  return {
    server: {
      port: 3000,
      host: '127.0.0.1',
      strictPort: true,
      ops: {
        authToken: undefined,
        tokenHeader: 'x-isr-admin-token',
        ...ops,
        health: {
          enabled: true,
          public: true,
          ...ops.health,
        },
        metrics: {
          enabled: false,
          public: false,
          ...ops.metrics,
        },
        inventory: {
          enabled: false,
          public: false,
          ...ops.inventory,
        },
      },
    },
  };
}

describe('resolveOpsConfig', () => {
  it('production 默认只公开 health', () => {
    const resolved = resolveOpsConfig({}, 'production');
    expect(resolved.health.enabled).toBe(true);
    expect(resolved.health.public).toBe(true);
    expect(resolved.metrics.enabled).toBe(false);
  });

  it('production 未配置 authToken 时自动关闭受保护 metrics', () => {
    const resolved = resolveOpsConfig(
      serverOpsConfig({
        metrics: { enabled: true },
      }),
      'production'
    );

    expect(resolved.metrics.enabled).toBe(false);
    expect(resolved.warnings[0]).toContain('/metrics');
  });

  it('production 显式 public 会保留并打印 warning', () => {
    const resolved = resolveOpsConfig(
      serverOpsConfig({
        metrics: { enabled: true, public: true },
      }),
      'production'
    );

    expect(resolved.metrics.enabled).toBe(true);
    expect(resolved.metrics.public).toBe(true);
    expect(resolved.warnings[0]).toContain('/metrics');
  });

  it('production 默认上线 inventory + 配 token → enabled', () => {
    // 不走 serverOpsConfig wrapper —— 它会注入 inventory:{enabled:false} 覆盖默认值。
    // 直接给最小配置，让 PROD_DEFAULTS.inventory 生效。
    const resolved = resolveOpsConfig(
      {
        server: {
          port: 3000,
          host: '127.0.0.1',
          strictPort: true,
          ops: {
            authToken: 'secret-token',
            tokenHeader: 'x-isr-admin-token',
            health: { enabled: true, public: true },
            metrics: { enabled: false, public: false },
            // inventory 故意不传 → 走 PROD_DEFAULTS
          },
        },
      } as never,
      'production'
    );
    expect(resolved.inventory.enabled).toBe(true);
    expect(resolved.inventory.public).toBe(false);
    expect(resolved.warnings).toEqual([]);
  });

  it('production inventory 没配 token → 自动 disable + warning', () => {
    const resolved = resolveOpsConfig(
      {
        server: {
          port: 3000,
          host: '127.0.0.1',
          strictPort: true,
          ops: {
            authToken: undefined,
            tokenHeader: 'x-isr-admin-token',
            health: { enabled: true, public: true },
            metrics: { enabled: false, public: false },
          },
        },
      } as never,
      'production'
    );
    expect(resolved.inventory.enabled).toBe(false);
    expect(resolved.warnings.some(w => w.includes('/__isr/cache/inventory'))).toBe(true);
  });

  it('development 默认 inventory public 开放（无需 token）', () => {
    const resolved = resolveOpsConfig({}, 'development');
    expect(resolved.inventory.enabled).toBe(true);
    expect(resolved.inventory.public).toBe(true);
  });
});

describe('createOpsAuthMiddleware', () => {
  it('允许 Bearer token 访问受保护端点', () => {
    const resolved = resolveOpsConfig(
      serverOpsConfig({
        authToken: 'secret-token',
        metrics: { enabled: true, public: false },
      }),
      'production'
    );
    const middleware = createOpsAuthMiddleware('metrics', resolved);
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
    const resolved = resolveOpsConfig(
      serverOpsConfig({
        authToken: 'secret-token',
        metrics: { enabled: true, public: false },
      }),
      'production'
    );
    const middleware = createOpsAuthMiddleware('metrics', resolved);
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
