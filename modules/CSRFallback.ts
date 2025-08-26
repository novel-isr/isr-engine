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
    this.logger.warn(`CSR fallback activated for: ${url}`, error?.message);

    try {
      const template = await this.getFallbackTemplate();
      const html = this.createCSRHTML(template, url, context, error);

      return {
        success: true,
        html,
        helmet: null,
        preloadLinks: '',
        statusCode: (error as any)?.statusCode || 200,
        meta: {
          renderMode: 'csr',
          fallback: true,
          error: error?.message,
          timestamp: Date.now(),
        },
      };
    } catch (fallbackError) {
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

  createCSRHTML(
    template: string,
    url: string,
    context: Record<string, any>,
    error?: Error
  ) {
    const isProduction = process.env.NODE_ENV === 'production';

    // Replace template variables
    let html = template
      .replace('{{ title }}', 'Loading...')
      .replace('<!--app-head-->', this.getCSRHead(url, context))
      .replace('<!--app-html-->', this.getCSRBody(url, error));

    // In production, ensure client bundle is loaded
    if (isProduction && !html.includes('entry-client')) {
      html = html.replace(
        '</head>',
        `  <script type="module" src="/assets/entry-client.js"></script>\n</head>`
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
      window.__CSR_FALLBACK__ = true;
      window.__INITIAL_URL__ = "${url}";
      window.__FALLBACK_TIMESTAMP__ = ${Date.now()};
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Application</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/entry-client.tsx"></script>
</body>
</html>`;
  }

  async preloadTemplate() {
    try {
      await this.getFallbackTemplate();
      this.logger.debug('CSR fallback template preloaded');
    } catch (error) {
      this.logger.warn(
        'Failed to preload CSR template:',
        (error as any)?.message || error
      );
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

    return fallbackConditions.some((condition) => condition);
  }

  getMetrics() {
    return {
      templateCached: !!this.fallbackTemplate,
      lastUsed: null, // this.lastUsed || null
    };
  }
}
