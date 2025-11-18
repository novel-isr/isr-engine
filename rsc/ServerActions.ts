/**
 * Server Actions Implementation
 * Provides a lightweight registry plus Express middleware.
 */

type RequestLike = {
  path: string;
  method: string;
  body?: any;
  ip?: string;
  connection?: { remoteAddress?: string };
  get?(name: string): string | undefined;
  [key: string]: any;
};

type ResponseLike = {
  status: (code: number) => ResponseLike;
  json: (body: any) => void;
};

type NextFunction = (err?: any) => void;

export interface ServerActionMetadata {
  id: string;
  name: string;
  module: string;
  line?: number;
  file?: string;
}

export interface ServerActionExecution {
  actionId: string;
  args: any[];
  timestamp: string;
  context: {
    userId?: string;
    sessionId?: string;
    userAgent?: string;
    ip?: string;
  };
}

export type ServerActionHandler = (...args: any[]) => Promise<any> | any;

class ServerActionsRegistry {
  private actions = new Map<string, ServerActionHandler>();
  private metadata = new Map<string, ServerActionMetadata>();

  register(
    id: string,
    handler: ServerActionHandler,
    metadata?: Partial<ServerActionMetadata>
  ): string {
    this.actions.set(id, handler);
    this.metadata.set(id, {
      id,
      name: metadata?.name || handler.name || 'anonymous',
      module: metadata?.module || 'unknown',
      line: metadata?.line,
      file: metadata?.file,
      ...metadata,
    });

    return id;
  }

  async execute(execution: ServerActionExecution): Promise<any> {
    const { actionId, args, context } = execution;

    const handler = this.actions.get(actionId);
    if (!handler) {
      throw new Error(`Server Action not found: ${actionId}`);
    }

    const metadata = this.metadata.get(actionId);
    console.log(`⚡ 执行 Server Action: ${metadata?.name || actionId}`);

    return handler(...args, { context });
  }

  getAllActions(): ServerActionMetadata[] {
    return Array.from(this.metadata.values());
  }

  hasAction(actionId: string): boolean {
    return this.actions.has(actionId);
  }
}

export function serverAction(metadata?: Partial<ServerActionMetadata>) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const actionId = `${target.constructor.name}.${propertyKey}:${Math.random().toString(36).substr(2, 9)}`;

    serverActionsRegistry.register(actionId, originalMethod, {
      name: propertyKey,
      module: target.constructor.name,
      ...metadata,
    });

    descriptor.value = function (...args: any[]) {
      if (typeof window === 'undefined') {
        return originalMethod.apply(this, args);
      }
      return executeServerActionOnClient(actionId, args);
    };

    return descriptor;
  };
}

export function createServerAction(
  handler: ServerActionHandler,
  metadata?: Partial<ServerActionMetadata>
): (...args: any[]) => Promise<any> {
  const actionId = `action:${Math.random().toString(36).substr(2, 12)}`;

  serverActionsRegistry.register(actionId, handler, metadata);

  return function (...args: any[]) {
    if (typeof window === 'undefined') {
      return handler(...args);
    }
    return executeServerActionOnClient(actionId, args);
  };
}

async function executeServerActionOnClient(actionId: string, args: any[]): Promise<any> {
  const response = await fetch('/api/server-actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Server-Action',
    },
    body: JSON.stringify({
      actionId,
      args,
      timestamp: new Date().toISOString(),
      context: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Server Action failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(result.error.message || 'Server Action execution failed');
  }

  return result.data;
}

export function serverActionsMiddleware() {
  return async (req: RequestLike, res: ResponseLike, next: NextFunction) => {
    if (req.path === '/api/server-actions' && req.method === 'POST') {
      try {
        const body = (req.body || {}) as Record<string, any>;
        const { actionId, args, timestamp, context } = body;

        if (!actionId) {
          return res.status(400).json({ error: { message: 'Action ID is required' } });
        }

        if (!serverActionsRegistry.hasAction(actionId)) {
          return res.status(404).json({ error: { message: `Server Action not found: ${actionId}` } });
        }

        const enhancedContext = {
          ...context,
          ip: req.ip || req.connection?.remoteAddress,
          userAgent: req.get ? req.get('User-Agent') : undefined,
          sessionId: (req as any).sessionID,
        };

        const execution: ServerActionExecution = {
          actionId,
          args: args || [],
          timestamp: timestamp || new Date().toISOString(),
          context: enhancedContext,
        };

        const result = await serverActionsRegistry.execute(execution);
        res.json({ data: result, success: true });
        return;
      } catch (error) {
        console.error('Server Action 执行错误:', error);
        return res.status(500).json({
          error: {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
          },
        });
      }
    }

    next();
  };
}

export const serverActionsRegistry = new ServerActionsRegistry();

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
        environment: 'server',
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd(),
      };
    }
    return {
      environment: 'client',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      timestamp: new Date().toISOString(),
    };
  },
  createCacheKey(actionId: string, args: any[]): string {
    const argsHash = JSON.stringify(args);
    return `server-action:${actionId}:${Buffer.from(argsHash).toString('base64')}`;
  },
};
