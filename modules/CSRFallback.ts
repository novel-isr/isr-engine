import fs from 'fs';
import path from 'path';

import { Logger } from '../utils/Logger';

/**
 * 客户端渲染降级模块
 * 在 SSR 失败时提供降级方案
 */
export class CSRFallback {
  private config: Record<string, any>;
  private logger: Logger;
  private fallbackTemplate: string | null;

  constructor(config: Record<string, any>) {
    this.config = config;
    this.logger = new Logger(config.dev?.verbose);
    this.fallbackTemplate = null;
  }

  async render(url: string, context: Record<string, any>, error?: Error) {
    console.log(`🌐 CSR 降级模式激活: ${url}`);
    this.logger.warn(`CSR fallback activated for: ${url}`, error?.message);

    try {
      // 对于强制 CSR 模式，使用默认模板而不是尝试加载项目模板
      const template =
        context.forceMode === 'csr' || context.forceFallback === 'client'
          ? this.getDefaultTemplate()
          : await this.getFallbackTemplate();

      const html = this.createCSRHTML(template, url, context, error);

      console.log(`✅ CSR 模式: HTML 已生成，长度: ${html.length}`);

      return {
        success: true,
        html,
        helmet: null,
        preloadLinks: '',
        statusCode: (error as any)?.statusCode || 200,
        meta: {
          renderMode: 'csr',
          strategy: 'client',
          fallback: true,
          error: error?.message,
          timestamp: Date.now(),
        },
      };
    } catch (fallbackError) {
      console.error('❌ CSR 降级失败:', fallbackError);
      this.logger.error('CSR fallback failed:', fallbackError);
      throw new Error(
        `Both SSR and CSR fallback failed: ${(fallbackError as any)?.message || fallbackError}`
      );
    }
  }

  async getFallbackTemplate() {
    if (this.fallbackTemplate && !this.config.dev?.hmr) {
      return this.fallbackTemplate;
    }

    try {
      // Try to load index.html template
      const templatePath = path.resolve(process.cwd(), 'index.html');
      const template = await fs.promises.readFile(templatePath, 'utf-8');

      if (!this.config.dev?.hmr) {
        this.fallbackTemplate = template;
      }

      return template;
    } catch (error) {
      this.logger.error('Failed to load HTML template:', error);
      return this.getDefaultTemplate();
    }
  }

  createCSRHTML(template: string, url: string, context: Record<string, any>, error?: Error) {
    const isProduction = process.env.NODE_ENV === 'production';

    // Replace template variables
    let html = template
      .replace('{{ title }}', 'Loading...')
      .replace('<!--app-head-->', this.getCSRHead(url, context))
      .replace('<!--app-html-->', this.getCSRBody(url, error));

    // In production, ensure client bundle is loaded (using universal entry)
    if (isProduction && !html.includes('entry.js')) {
      html = html.replace(
        '</head>',
        `  <script type="module" src="/assets/entry.js"></script>\n</head>`
      );
    }

    return html;
  }

  getCSRHead(url: string, context: Record<string, any>) {
    return `
    <meta name="description" content="Client-side rendered application">
    <meta name="robots" content="noindex,nofollow">
    <meta name="ssr-fallback" content="true">
    <meta name="original-url" content="${url}">
    <script>
      // 注入 CSR 模式的渲染信息
      window.__ISR_MODE__ = 'csr';
      window.__RENDER_STRATEGY__ = 'client';
      window.__FALLBACK_USED__ = true;
      window.__RENDER_URL__ = '${url}';
      window.__RENDER_TIME__ = '${new Date().toISOString()}';
      window.__FORCE_MODE__ = '${context.forceMode || ''}';
      window.__FORCE_FALLBACK__ = '${context.forceFallback || ''}';
      window.__SERVER_VARIABLES__ = {
        mode: 'csr',
        strategy: 'client',
        fallback: true,
        url: '${url}',
        timestamp: '${new Date().toISOString()}'
      };
      
      // 保持向后兼容
      window.__CSR_FALLBACK__ = true;
      window.__INITIAL_URL__ = "${url}";
      window.__FALLBACK_TIMESTAMP__ = ${Date.now()};
      
      // 降级检测日志
      console.warn('⚠️ 渲染降级检测: 已降级到CSR客户端渲染');
      console.warn('📉 降级详情:', {
        请求模式: new URLSearchParams(location.search).get('mode') || 'auto',
        实际模式: 'csr',
        渲染策略: 'client',
        降级原因: '服务端渲染不可用'
      });
    </script>`;
  }

  getCSRBody(url: string, error?: Error) {
    const showError = this.config.dev?.verbose && error;

    return `
    <div id="root">
      <div style="
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        background-color: #f5f5f5;
      ">
        <div style="text-align: center; max-width: 500px; padding: 2rem;">
          <div style="
            width: 50px;
            height: 50px;
            border: 3px solid #ddd;
            border-top: 3px solid #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1rem;
          "></div>
          <h2 style="color: #333; margin-bottom: 1rem;">Loading Application...</h2>
          <p style="color: #666; margin-bottom: 1rem;">
            The page is being rendered on the client side.
          </p>
          ${
            showError
              ? `
          <details style="text-align: left; margin-top: 2rem;">
            <summary style="cursor: pointer; color: #007acc;">Debug Information</summary>
            <pre style="
              background: #f8f8f8;
              padding: 1rem;
              border-radius: 4px;
              overflow: auto;
              font-size: 0.8rem;
              margin-top: 1rem;
            ">${this.formatError(error)}</pre>
          </details>
          `
              : ''
          }
        </div>
      </div>
      <style>
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </div>`;
  }

  formatError(error?: Error) {
    if (!error) return '';

    return [
      `Error: ${error.message}`,
      error.stack ? `\nStack Trace:\n${error.stack}` : '',
      (error as any).url ? `\nURL: ${(error as any).url}` : '',
      `\nTimestamp: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('');
  }

  getDefaultTemplate() {
    const isDev = process.env.NODE_ENV !== 'production';

    // 注入渲染模式变量的脚本（必须在其他脚本之前）
    const variablesScript = `
  <script>
    // 注入 CSR 模式的渲染信息
    window.__ISR_MODE__ = 'csr';
    window.__RENDER_STRATEGY__ = 'client';
    window.__FALLBACK_USED__ = true;
    window.__RENDER_URL__ = location.pathname + location.search;
    window.__RENDER_TIME__ = '${new Date().toISOString()}';
    window.__FORCE_MODE__ = new URLSearchParams(location.search).get('mode') || '';
    window.__FORCE_FALLBACK__ = new URLSearchParams(location.search).get('fallback') || '';
    window.__SERVER_VARIABLES__ = {
      mode: 'csr',
      strategy: 'client',
      fallback: true,
      url: location.pathname + location.search,
      timestamp: '${new Date().toISOString()}'
    };
    
    // 保持向后兼容
    window.__CSR_FALLBACK__ = true;
    window.__INITIAL_URL__ = location.pathname + location.search;
    window.__FALLBACK_TIMESTAMP__ = ${Date.now()};
  </script>`;

    const devScripts = isDev
      ? `${variablesScript}
  <script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module" src="/@vite/client"></script>
  <script type="module">
    console.log('🎯 CSR 降级模式 - 正在加载通用入口...');
    
    // 防止重复初始化
    if (window.__CSR_INITIALIZED__) {
      console.log('⚠️ CSR 已初始化，跳过重复调用');
    } else {
      window.__CSR_INITIALIZED__ = true;
      
      (async () => {
        try {
          // 预加载项目样式
          await import('/src/styles/global.scss');
          console.log('✅ 项目样式已加载');
          
          const mod = await import('/src/entry.tsx');
          if (typeof mod.renderClient === 'function') {
            console.log('🚀 CSR 模式: 客户端渲染已启动');
            mod.renderClient();
          }
        } catch (e) {
          console.error('❌ CSR 模式: 加载通用入口失败:', e);
          // 重置标志，允许重试
          window.__CSR_INITIALIZED__ = false;
        }
      })();
    }
  </script>`
      : `${variablesScript}
  <script type="module" src="/assets/entry.js"></script>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Novel Rating - CSR Mode</title>
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <meta name="description" content="Novel Rating Application - Client Side Rendered">
  <style>
    /* 基础样式，与项目主题保持一致 */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      font-weight: clamp(400, 600, 700);
      color-scheme: light dark;
      color: #ffffff;
      background-color: #242424;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    
    body {
      font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      background-color: #242424;
      color: #ffffff;
      line-height: 1.6;
      margin: 0;
      padding: 0;
    }
    
    #root {
      min-height: 100vh;
      background-color: #242424;
    }
    
    /* Loading 状态样式 */
    .csr-loading {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      flex-direction: column;
      background-color: #242424;
    }
    
    .csr-spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #444;
      border-top: 4px solid #007acc;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 16px;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .csr-text {
      color: #ccc;
      font-size: 14px;
    }
  </style>${devScripts}
</head>
<body>
  <div id="root">
    <div class="csr-loading">
      <div class="csr-spinner"></div>
      <div class="csr-text">正在加载应用...</div>
    </div>
  </div>
</body>
</html>`;
  }

  async preloadTemplate() {
    try {
      await this.getFallbackTemplate();
      this.logger.debug('CSR fallback template preloaded');
    } catch (error) {
      this.logger.warn('Failed to preload CSR template:', (error as any)?.message || error);
    }
  }

  shouldUseFallback(error?: Error) {
    // Define conditions where CSR fallback should be used
    const fallbackConditions = [
      (error as any)?.code === 'MODULE_NOT_FOUND',
      error?.message?.includes('hydration'),
      error?.message?.includes('timeout'),
      (error as any)?.statusCode >= 500,
    ];

    return fallbackConditions.some(condition => condition);
  }

  getMetrics() {
    return {
      templateCached: !!this.fallbackTemplate,
      lastUsed: null, // this.lastUsed || null
    };
  }
}
