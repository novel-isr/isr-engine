/**
 * Vite ISR 插件
 * 为 Novel ISR 引擎提供 Vite 集成支持
 */

import { Plugin, ViteDevServer } from 'vite';
import { NovelISRConfig } from '../types';
import ISREngine from '../engines/ISREngine';

interface ViteISRPluginOptions {
  config?: NovelISRConfig;
  entry?: string;
  enableHMR?: boolean;
  enableDevMiddleware?: boolean;
}

/**
 * 创建 Vite ISR 插件
 */
export function createViteISRPlugin(
  options: ViteISRPluginOptions = {}
): Plugin {
  const { 
    config = {}, 
    entry = '/src/entry.tsx',
    enableHMR = true,
    enableDevMiddleware = false 
  } = options;

  let isrEngine: ISREngine;
  let server: ViteDevServer;

  return {
    name: 'vite-isr-plugin',
    configureServer(viteServer) {
      server = viteServer;

      // 只有在启用开发中间件时才初始化 ISR 引擎
      if (enableDevMiddleware) {
        // 初始化 ISR 引擎
        isrEngine = new ISREngine(config);

        // 添加 ISR 中间件
        server.middlewares.use(async (req, res, next) => {
          try {
            const url = req.url!;

            // 跳过资源文件和 API 路由
            if (shouldSkipISR(url)) {
              return next();
            }

            // 使用 ISR 引擎渲染
            const result = await isrEngine.render(url, {
              userAgent: req.headers['user-agent'],
              acceptLanguage: req.headers['accept-language'],
              referer: req.headers.referer,
              bypassCache: (req as any).query?.nocache === '1',
              viteServer: server, // 传递 Vite 服务器实例
            });

            if (result) {
              res.statusCode = result.statusCode || 200;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');

              // 添加 ISR 头信息
              if (result.meta) {
                res.setHeader('X-ISR-Mode', result.meta.renderMode || 'isr');
                res.setHeader(
                  'X-ISR-Strategy',
                  result.meta.strategy || 'unknown'
                );
                if (result.meta.fromCache) {
                  res.setHeader('X-ISR-Cache', 'HIT');
                }
              }

              // 在开发模式下添加 HMR 脚本
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
                const htmlWithHMR = result.html.replace('</head>', `${hmrScript}</head>`);
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
      console.log('🎯 Novel ISR - Vite 构建开始');
    },

    buildEnd() {
      console.log('✅ Novel ISR - Vite 构建完成');
    },

    // 配置 ISR 构建选项
    config(config: any, { command }: { command: string }) {
      if (command === 'build') {
        config.build = config.build || {};

        // 客户端构建配置
        if (!config.build.ssr) {
          config.build.manifest = true;
          config.build.ssrManifest = true;
        }
      }

      // ISR 优化配置
      config.ssr = config.ssr || {};
      config.ssr.noExternal = config.ssr.noExternal || [];
      if (Array.isArray(config.ssr.noExternal)) {
        config.ssr.noExternal.push('@novel-isr/engine');
      }

      return config;
    },

    // 处理虚拟模块
    resolveId(id: string) {
      if (id === 'virtual:ssr-manifest') {
        return id;
      }
    },

    load(id: string) {
      if (id === 'virtual:ssr-manifest') {
        return 'export default {}'; // 在开发模式下返回空对象
      }
    },
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

  // API 路由 (可配置)
  if (url.startsWith('/api/') || url.startsWith('/_')) {
    return true;
  }

  return false;
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
      });

      if (result) {
        res.statusCode = result.statusCode || 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-ISR-Mode', 'dev');
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
