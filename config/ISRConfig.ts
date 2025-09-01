import { RenderModes, CacheStrategies, InternalStrategies } from '../types';

/**
 * Enterprise ISR Configuration
 */
export class ISRConfig {
  public mode: string;
  public fallbackStrategy: string;
  public cache: Record<string, any>;
  public server: Record<string, any>;
  public seo: Record<string, any>;
  public paths: Record<string, any>;
  public isr: Record<string, any>;
  public errorHandling: Record<string, any>;
  public dev: Record<string, any>;

  constructor(options: Record<string, any> = {}) {
    this.mode = options.mode || RenderModes.ISR;
    this.fallbackStrategy = options.fallbackStrategy || InternalStrategies.CLIENT;
    this.cache = {
      strategy: options.cache?.strategy || CacheStrategies.MEMORY,
      ttl: options.cache?.ttl || 3600, // 1 hour
      maxSize: options.cache?.maxSize || 1000,
      ...options.cache,
    };

    // Server configuration
    this.server = {
      port: options.server?.port || 3000,
      host: options.server?.host || 'localhost',
      compression: options.server?.compression !== false,
      cors: options.server?.cors || false,
      ...options.server,
    };

    // SEO configuration
    this.seo = {
      domain: options.seo?.domain || 'https://localhost:3000',
      generateRobots: options.seo?.generateRobots !== false,
      generateSitemap: options.seo?.generateSitemap !== false,
      enableSpider: options.seo?.enableSpider || false,
      spiderConfig: {
        concurrency: 5,
        delay: 1000,
        userAgent: 'ISR-Engine-Spider/1.0',
        ...options.seo?.spiderConfig,
      },
      ...options.seo,
    };

    // Build paths
    this.paths = {
      dist: options.paths?.dist || './dist',
      client: options.paths?.client || './dist/client',
      server: options.paths?.server || './dist/server',
      static: options.paths?.static || './dist/static',
      ...options.paths,
    };

    // ISR configuration
    this.isr = {
      enabled: options.isr?.enabled || false,
      revalidate: options.isr?.revalidate || 3600,
      background: options.isr?.background || true,
      ...options.isr,
    };

    // Error handling
    this.errorHandling = {
      enableFallback: options.errorHandling?.enableFallback !== false,
      logErrors: options.errorHandling?.logErrors !== false,
      customErrorPage: options.errorHandling?.customErrorPage,
      ...options.errorHandling,
    };

    // Development settings
    this.dev = {
      hmr: options.dev?.hmr !== false,
      sourceMap: options.dev?.sourceMap !== false,
      ...options.dev,
    };
  }

  validate() {
    const errors = [];

    if (!Object.values(RenderModes).includes(this.mode as any)) {
      errors.push(`Invalid render mode: ${this.mode}`);
    }

    if (!Object.values(CacheStrategies).includes(this.cache.strategy)) {
      errors.push(`Invalid cache strategy: ${this.cache.strategy}`);
    }

    if (!this.seo.domain || !this.seo.domain.startsWith('http')) {
      errors.push('SEO domain must be a valid URL');
    }

    if (this.server.port < 1 || this.server.port > 65535) {
      errors.push('Server port must be between 1 and 65535');
    }

    return errors;
  }

  static createDefault() {
    return new ISRConfig({
      mode: RenderModes.ISR,
      fallbackStrategy: InternalStrategies.CLIENT,
      server: {
        port: 3000,
        compression: true,
      },
      seo: {
        domain: 'https://localhost:3000',
        generateRobots: true,
        generateSitemap: true,
      },
    });
  }

  static createProduction(overrides: Record<string, any> = {}) {
    return new ISRConfig({
      mode: RenderModes.ISR,
      cache: {
        strategy: CacheStrategies.MEMORY,
        ttl: 3600,
      },
      server: {
        compression: true,
        cors: false,
      },
      errorHandling: {
        logErrors: true,
        enableFallback: true,
      },
      ...overrides,
    });
  }
}
