import { RenderModes, RenderModeType, NovelISRConfig, EnterpriseConfigOptions } from '../types';

/**
 * Enterprise ISR Configuration
 * Simplified API with automatic fallback handling
 */
export class EnterpriseConfig {
  public routes: Map<string, RenderModeType>;
  public globalMode: RenderModeType;
  public config: Record<string, any>;

  constructor(options: NovelISRConfig = {}) {
    this.routes = new Map();
    this.globalMode = options.mode || RenderModes.ISR;
    this.config = this.createBaseConfig(options);

    // Route-specific configurations
    if (options.routes) {
      this.configureRoutes(options.routes);
    }
  }

  /**
   * Configure routes with their rendering modes
   * @param {Object} routes - Route configuration object
   * @example
   * {
   *   '/': 'ssg',
   *   '/about': 'ssg',
   *   '/posts/*': 'isr'
   * }
   */
  configureRoutes(routes: Record<string, RenderModeType>) {
    for (const [pattern, mode] of Object.entries(routes)) {
      if (!Object.values(RenderModes).includes(mode as RenderModeType)) {
        throw new Error(`Invalid mode '${mode}' for route '${pattern}'. Use 'ssg' or 'isr'.`);
      }
      this.routes.set(pattern, mode as RenderModeType);
    }
  }

  /**
   * Get render mode for a specific route
   */
  getRenderMode(path: string) {
    // Check for exact match first
    if (this.routes.has(path)) {
      return this.routes.get(path);
    }

    // Check for pattern matches
    for (const [pattern, mode] of this.routes.entries()) {
      if (this.matchesPattern(path, pattern)) {
        return mode;
      }
    }

    // Return global default
    return this.globalMode;
  }

  /**
   * Simple pattern matching for routes
   */
  matchesPattern(path: string, pattern: string) {
    if (pattern.endsWith('/*')) {
      const basePattern = pattern.slice(0, -2);
      return path.startsWith(basePattern);
    }

    if (pattern.includes('[') && pattern.includes(']')) {
      // Convert Next.js style patterns to regex
      const regexPattern = pattern.replace(/\[([^\]]+)\]/g, '([^/]+)').replace(/\//g, '\\/');

      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(path);
    }

    return path === pattern;
  }

  /**
   * Create base configuration
   */
  createBaseConfig(options: NovelISRConfig): Record<string, any> {
    return {
      // Public modes only
      mode: this.globalMode,

      // Server configuration
      server: {
        port: options.server?.port || 3000,
        host: options.server?.host || 'localhost',
        compression: options.compression !== false,
        cors: false,
      },

      // ISR configuration
      isr: {
        revalidate: options.isr?.revalidate || 3600, // 1 hour default
        background: options.isr?.backgroundRevalidation !== false,
        maxAge: 86400, // 24 hours
      },

      // Cache configuration
      cache: {
        strategy: options.cache?.strategy || 'memory',
        ttl: options.cache?.ttl || 3600,
        maxSize: 100,
      },

      // Paths
      paths: {
        dist: options.paths?.dist || 'dist',
        server: options.paths?.server || 'dist/server',
        static: options.paths?.static || 'dist/client',
        public: 'public',
      },

      // SEO configuration
      seo: {
        enabled: options.seo?.enabled !== false,
        generateSitemap: options.seo?.generateSitemap !== false,
        generateRobots: options.seo?.generateRobots !== false,
        baseUrl: options.seo?.baseUrl || 'https://example.com',
      },

      // Development options
      dev: {
        verbose: options.dev?.verbose || false,
        hmr: options.dev?.hmr || false,
      },

      // Error handling
      errorHandling: {
        enableFallback: true, // Always enable automatic fallback
        logErrors: options.errorHandling?.logErrors !== false,
      },

      // Enterprise features
      enterprise: {
        monitoring: false,
        analytics: false,
        loadBalancing: false,
      },
    };
  }

  /**
   * Validate configuration
   */
  validate() {
    const errors = [];

    // Validate global mode
    if (!Object.values(RenderModes).includes(this.globalMode)) {
      errors.push(`Invalid global mode: ${this.globalMode}`);
    }

    // Validate route modes
    for (const [pattern, mode] of this.routes.entries()) {
      if (!Object.values(RenderModes).includes(mode)) {
        errors.push(`Invalid mode '${mode}' for route '${pattern}'`);
      }
    }

    // Validate required paths
    const requiredPaths = ['dist', 'server', 'static'];
    for (const path of requiredPaths) {
      if (!this.config.paths[path]) {
        errors.push(`Missing required path: ${path}`);
      }
    }

    return errors;
  }

  /**
   * Get configuration for ISR Engine
   */
  getEngineConfig(path = '/') {
    const mode = this.getRenderMode(path);

    return {
      ...this.config,
      mode,
      currentPath: path,
    };
  }

  /**
   * Create production configuration
   */
  static createProduction(overrides: Partial<NovelISRConfig> = {}) {
    return new EnterpriseConfig({
      mode: RenderModes.ISR,
      compression: true,
      dev: { verbose: false, hmr: false },
      cache: { strategy: 'redis', ttl: 3600 },
      isr: { revalidate: 3600, backgroundRevalidation: true },
      ...overrides,
    });
  }

  /**
   * Create development configuration
   */
  static createDevelopment(overrides: Partial<NovelISRConfig> = {}) {
    return new EnterpriseConfig({
      mode: RenderModes.ISR,
      dev: { verbose: true, hmr: true },
      cache: { strategy: 'memory', ttl: 60 },
      isr: { revalidate: 30, backgroundRevalidation: false },
      ...overrides,
    });
  }
}
