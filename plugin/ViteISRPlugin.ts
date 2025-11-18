/**
 * Novel ISR Vite 插件
 * 为 Novel ISR 引擎提供 Vite 集成支持
 *
 * 核心功能：
 * - RSC (React Server Components) 支持
 * - ISR/SSR/SSG/CSR 自动降级链
 * - AppShell 共享和多入口架构
 * - HMR 和开发时优化
 * - 生产构建优化
 */

import { Plugin, ViteDevServer } from 'vite';
import { NovelISRConfig } from '../types';
import ISREngine from '../engines/ISREngine';

interface ViteISRPluginOptions {
  config?: NovelISRConfig;
  entry?: string;
  enableHMR?: boolean;
  enableDevMiddleware?: boolean;
  rsc?: {
    enabled: boolean;
    componentsDir: string;
  };
  appShell?: {
    enabled: boolean;
    template: string;
  };
  multiEntry?: {
    enabled: boolean;
    entries: Record<string, string>;
  };
}

/**
 * 创建 Vite ISR 插件
 */
export function createViteISRPlugin(
  options: ViteISRPluginOptions = {}
): Plugin[] {
  const {
    config = {},
    entry = '/src/entry.tsx',
    enableHMR = true,
    enableDevMiddleware = false,
    rsc = { enabled: true, componentsDir: 'src/components' },
    appShell = { enabled: true, template: 'src/App.tsx' },
    multiEntry = { enabled: false, entries: {} },
  } = options;

  let isrEngine: ISREngine;
  let server: ViteDevServer;

  // 主要的 ISR 插件
  const isrPlugin: Plugin = {
    name: 'vite-isr-plugin',

    config(config, { command }) {
      if (command === 'build') {
        config.build = config.build || {};
        config.build.rollupOptions = config.build.rollupOptions || {};

        // 多入口支持
        if (multiEntry.enabled) {
          config.build.rollupOptions.input = {
            main: entry,
            ...multiEntry.entries,
          };
        }

        // RSC 优化
        if (rsc.enabled) {
          config.ssr = config.ssr || {};
          config.ssr.noExternal = config.ssr.noExternal || [];
          if (Array.isArray(config.ssr.noExternal)) {
            config.ssr.noExternal.push(
              '@novel-isr/engine',
              'react',
              'react-dom'
            );
          }
        }

        // 构建输出配置
        if (!config.build.ssr) {
          config.build.manifest = true;
          config.build.ssrManifest = true;
          config.build.outDir = 'dist/client';
        } else {
          config.build.outDir = 'dist/server';
        }
      }

      return config;
    },

    configureServer(viteServer) {
      server = viteServer;

      if (enableDevMiddleware) {
        isrEngine = new ISREngine(config);

        server.middlewares.use(async (req, res, next) => {
          try {
            const url = req.url || '';

            if (shouldSkipISR(url)) {
              return next();
            }

            const result = await isrEngine.render(url, {
              userAgent: req.headers['user-agent'],
              acceptLanguage: req.headers['accept-language'],
              referer: req.headers.referer,
              bypassCache: false,
              viteServer: server,
              rscEnabled: rsc.enabled,
            });

            if (result) {
              res.statusCode = result.statusCode || 200;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');

              if (result.meta) {
                res.setHeader(
                  'X-ISR-Mode',
                  result.meta.renderMode || 'isr'
                );
                res.setHeader(
                  'X-ISR-Strategy',
                  result.meta.strategy || 'unknown'
                );
                if (result.meta.fromCache) {
                  res.setHeader('X-ISR-Cache', 'HIT');
                }
              }

              if (enableHMR && process.env.NODE_ENV !== 'production') {
                const hmrScript = `
                  <script type="module">
                    import.meta.hot.accept();
                    if (import.meta.hot) {
                      import.meta.hot.on('vite:beforeUpdate', () => {
                        console.log('[ISR] HMR update received');
                      });
                    }
                  </script>
                `;
                const htmlWithHMR = result.html.replace(
                  '</head>',
                  `${hmrScript}</head>`
                );
                res.end(htmlWithHMR);
              } else {
                res.end(result.html);
              }
            } else {
              next();
            }
          } catch (error) {
            console.error('ISR 渲染错误:', error);
            next();
          }
        });
      }
    },

    buildStart() {
      console.log('🎯 企业级 Novel ISR - Vite 构建开始');
    },

    buildEnd() {
      console.log('✅ 企业级 Novel ISR - Vite 构建完成');
    },

    resolveId(id: string) {
      if (
        id === 'virtual:ssr-manifest' ||
        id === 'virtual:rsc-manifest' ||
        id === 'virtual:app-shell'
      ) {
        return id;
      }
    },

    load(id: string) {
      if (id === 'virtual:ssr-manifest') {
        return 'export default {};';
      }

      if (id === 'virtual:rsc-manifest') {
        return `export default { timestamp: ${Date.now()}, enabled: ${
          rsc.enabled
        } };`;
      }

      if (id === 'virtual:app-shell') {
        const config = {
          enabled: appShell.enabled,
          template: appShell.template,
          multiEntry: multiEntry.enabled,
          entries: multiEntry.entries,
        };
        return `export default ${JSON.stringify(config)};`;
      }
    },
  };

  // RSC 优化插件
  const rscPlugin: Plugin = {
    name: 'rsc-optimization-plugin',

    config(config) {
      if (!rsc.enabled) return;

      config.ssr = config.ssr || {};
      config.ssr.noExternal = config.ssr.noExternal || [];

      if (Array.isArray(config.ssr.noExternal)) {
        config.ssr.noExternal.push(
          '@novel-isr/engine',
          'react/jsx-runtime',
          'react/jsx-dev-runtime'
        );
      }

      config.resolve = config.resolve || {};
      config.resolve.conditions = config.resolve.conditions || [];
      config.resolve.conditions.push('react-server');
    },

    transform(code, id) {
      if (!rsc.enabled) return null;

      // 简化的组件标记
      if (id.includes('.server.')) {
        return {
          code: `// @server-component\n${code}`,
          map: null,
        };
      }

      if (id.includes('.client.')) {
        return {
          code: `// @client-component\n${code}`,
          map: null,
        };
      }

      return null;
    },
  };

  // 多入口插件
  const multiEntryPlugin: Plugin = {
    name: 'multi-entry-plugin',

    config(config, { command }) {
      if (!multiEntry.enabled || command !== 'build') return;

      config.build = config.build || {};
      config.build.rollupOptions = config.build.rollupOptions || {};

      config.build.rollupOptions.input = {
        'app-shell': appShell.template,
        ...multiEntry.entries,
      };

      config.build.rollupOptions.output = {
        ...config.build.rollupOptions.output,
        manualChunks: {
          'app-shell': [appShell.template],
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      };
    },
  };

  return [isrPlugin, rscPlugin, multiEntryPlugin];
}

/**
 * 创建 Vite 开发中间件
 */
export function createViteDevMiddleware(isrEngine: ISREngine) {
  return async (
    req: { url: string; headers: Record<string, string> },
    res: {
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (data: string) => void;
    },
    next: () => void
  ) => {
    try {
      const url = req.url;

      if (shouldSkipISR(url)) {
        return next();
      }

      const result = await isrEngine.render(url, {
        userAgent: req.headers['user-agent'],
        acceptLanguage: req.headers['accept-language'],
        viteHMR: true,
        rscEnabled: true,
      });

      if (result) {
        res.statusCode = result.statusCode || 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-ISR-Mode', 'dev');
        res.setHeader('X-RSC-Enabled', 'true');
        res.end(result.html);
      } else {
        next();
      }
    } catch (error) {
      console.error('ISR 中间件错误:', error);
      next();
    }
  };
}

/**
 * 判断是否应该跳过 ISR
 */
function shouldSkipISR(url: string): boolean {
  // 静态资源
  if (url.includes('.')) {
    const ext = url.split('.').pop()?.toLowerCase();
    const staticExts = [
      'js',
      'css',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'svg',
      'ico',
      'woff',
      'woff2',
      'ttf',
      'eot',
    ];
    if (ext && staticExts.includes(ext)) {
      return true;
    }
  }

  // Vite 内部路由
  if (url.startsWith('/@') || url.startsWith('/__vite')) {
    return true;
  }

  // API 路由
  if (url.startsWith('/api/') || url.startsWith('/_')) {
    return true;
  }

  return false;
}

