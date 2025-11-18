/**
 * SSR 渲染器
 * ✅ 符合规则：所有 SSR 实现都在 isr-engine 中，应用项目只提供 App 组件
 * ✅ 功能：完整的 SSR 流程 - RSC 注册、数据注入、Flight 序列化、HTML 生成、样式扫描
 */

import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { RenderContext } from '../types';
import { Logger } from '../utils/Logger';
import { plumberProtocol } from '../rsc/PlumberProtocol';
import type { RSCRuntime } from '../rsc/RSCRuntime';

interface SerializedFlightPayload {
  chunks: unknown[];
  moduleMap: Array<[string, unknown]>;
  actionMap: Array<[string, unknown]>;
  metadata: {
    timestamp: string;
    renderMode: string;
    componentCount: number;
  };
}

type HelmetRenderable = { toString(): string };

interface HelmetSections {
  htmlAttributes?: HelmetRenderable;
  bodyAttributes?: HelmetRenderable;
  title?: HelmetRenderable;
  meta?: HelmetRenderable;
  link?: HelmetRenderable;
  style?: HelmetRenderable;
  script?: HelmetRenderable;
}

interface SSRHelmetContext {
  helmet?: HelmetSections;
}

type RouteData = {
  books?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type RegisteredComponentMeta = {
  styleLoaders?: unknown[];
};

type ViteModuleNode = {
  url?: string | null;
};

type FlightRenderContext = {
  renderMode?: string;
};

type HtmlRenderContext = {
  renderTime?: string;
  renderMode?: string;
  strategy?: string;
  fallbackUsed?: boolean;
  rscStylesMissing?: boolean;
  routeData?: RouteData;
};

type ViteLikeServer =
  | {
      moduleGraph: {
        getModuleById(id: string): ViteModuleNode | undefined | null;
      };
    }
  | undefined;

/**
 * SSR 渲染器类
 */
export class SSRRenderer {
  private logger: Logger;

  constructor(verbose = false) {
    this.logger = new Logger(verbose);
  }

  /**
   * 执行完整的 SSR 渲染流程
   * ✅ 步骤：RSC 数据注入 → Flight 序列化 → React renderToString → HTML 模板 → 样式扫描
   */
  async render(options: {
    url: string;
    context: RenderContext;
    appElement: ReactElement;
    helmetContext: SSRHelmetContext;
    rscRuntime?: RSCRuntime;
  }): Promise<{
    html: string;
    rscPayload: SerializedFlightPayload | null;
    helmet?: HelmetSections;
    statusCode: number;
    renderTime: string;
  }> {
    const { url, context, appElement, helmetContext, rscRuntime } = options;
    const renderTime = context.renderTime || new Date().toISOString();

    this.logger.info(`🚀 开始 SSR 渲染: ${url}`);

    try {
      let elementWithData = appElement;
      let componentStyles: string[] = [];

      // ✅ 步骤1：RSC 数据注入（如果启用 RSC）
      if (rscRuntime && context.routeData) {
        this.logger.debug('📋 步骤1: 注入路由数据到 RSC 组件...');
        const result = await this.injectRouteDataToRSC(appElement, context.routeData, rscRuntime);
        elementWithData = result.element;
        componentStyles = result.componentStyles;
        this.logger.debug(`✅ 步骤1完成: ${componentStyles.length} 个组件样式`);
      }

      context.rscComponentStyles = componentStyles;
      context.rscStylesMissing = componentStyles.length === 0;

      // ✅ 步骤2: Flight 序列化
      this.logger.debug('📋 步骤2: Flight 协议序列化...');
      const flightPayload = await this.generateFlightPayload(
        elementWithData,
        context as FlightRenderContext
      );
      this.logger.debug('✅ 步骤2完成: Flight 序列化完成');

      // ✅ 步骤3: React renderToString
      this.logger.debug('📋 步骤3: React renderToString...');
      const html = renderToString(elementWithData);
      this.logger.debug(`✅ 步骤3完成: HTML 生成 ${html.length} 字符`);

      // ✅ 步骤4: 样式扫描（如果有 viteServer）
      const runtimeStyleLinks = this.generateRuntimeStyleLinks(
        context.viteServer as ViteLikeServer,
        componentStyles
      );

      // ✅ 步骤5: HTML 模板生成
      const fullHtml = this.createStreamingSSRHTML({
        html,
        url,
        context: { ...context, renderTime } as HtmlRenderContext,
        helmet: helmetContext.helmet,
        preloadLinks: this.generatePreloadLinks(
          context.manifest as Record<string, string[] | string> | undefined
        ),
        flightPayload,
        componentStyles,
        runtimeStyleLinks,
      });

      this.logger.info(`✅ SSR 渲染完成: ${url}`);

      return {
        html: fullHtml,
        rscPayload: flightPayload,
        helmet: helmetContext.helmet,
        statusCode: 200,
        renderTime,
      };
    } catch (error) {
      this.logger.error('❌ SSR 渲染失败:', error);
      throw error;
    }
  }

  /**
   * 注入路由数据到 RSC 组件
   * ✅ 符合规则：SSR 必须使用 isr-engine 获取的实时数据，而非缓存
   */
  private async injectRouteDataToRSC(
    appElement: ReactElement,
    routeData: RouteData,
    rscRuntime: RSCRuntime
  ): Promise<{
    element: ReactElement;
    componentStyles: string[];
  }> {
    try {
      // 自动发现 RSC 组件
      await rscRuntime.discoverRSCComponents(appElement);
      rscRuntime.resetRecentComponentUsage();

      // ✅ 使用 routeData 而非预取缓存（实时数据）
      const dataMap = new Map<string, unknown>();
      const books = Array.isArray(routeData.books) ? routeData.books : [];
      dataMap.set('BookListServer', books);
      if (books.length > 0) {
        this.logger.debug(`✅ 注入实时书籍数据: ${books.length} 条`);
      } else {
        this.logger.debug('⚠️ 注入实时书籍数据: 0 条 (使用空状态)');
      }

      // 注入数据到组件 props
      const elementWithData = await rscRuntime.injectRSCData(appElement, dataMap);

      // 收集组件样式
      const registeredComponents = rscRuntime.getRegisteredComponents() as Map<
        string,
        RegisteredComponentMeta
      >;
      const componentStyles: string[] = [];
      const componentsToProcessStyles = Array.from(dataMap.keys());

      for (const componentName of componentsToProcessStyles) {
        const componentMeta = registeredComponents.get(componentName);
        if (Array.isArray(componentMeta?.styleLoaders) && componentMeta.styleLoaders.length > 0) {
          componentStyles.push(componentName);
        }
      }

      return { element: elementWithData, componentStyles };
    } catch (error) {
      this.logger.error('❌ 注入路由数据失败:', error);
      return { element: appElement, componentStyles: [] };
    }
  }

  /**
   * 生成 Flight 协议 payload
   */
  private async generateFlightPayload(
    element: ReactElement,
    context: FlightRenderContext
  ): Promise<SerializedFlightPayload | null> {
    try {
      const stream = plumberProtocol.encode(element, {
        renderMode: context.renderMode || 'isr',
      });

      return {
        chunks: stream.chunks,
        moduleMap: Array.from(stream.moduleMap.entries()),
        actionMap: Array.from(stream.actionMap.entries()),
        metadata: {
          timestamp: new Date().toISOString(),
          renderMode: context.renderMode || 'isr',
          componentCount: stream.moduleMap.size,
        },
      };
    } catch (error) {
      this.logger.error('❌ Flight 序列化失败:', error);
      return null;
    }
  }

  /**
   * 生成运行时样式链接
   * ✅ 符合规则：完整实现运行时样式扫描，使用 Vite moduleGraph
   */
  private generateRuntimeStyleLinks(viteServer: ViteLikeServer, componentNames: string[]): string {
    if (!viteServer || componentNames.length === 0) {
      return '<!-- Runtime styles: none or Vite server unavailable -->';
    }

    try {
      const styleLinks: string[] = [];

      for (const componentName of componentNames) {
        const componentPath = `/src/components/${componentName}/${componentName}.module.scss`;
        const moduleNode = viteServer.moduleGraph.getModuleById(componentPath);
        if (moduleNode && moduleNode.url) {
          styleLinks.push(`<link rel="stylesheet" href="${moduleNode.url}" />`);
        }
      }

      if (styleLinks.length > 0) {
        this.logger.debug(`✅ 生成运行时样式链接: ${styleLinks.length} 个`);
        return styleLinks.join('\n  ');
      }

      return '<!-- No runtime styles detected -->';
    } catch (error) {
      this.logger.error('❌ 生成运行时样式链接失败:', error);
      return '<!-- Runtime style generation failed -->';
    }
  }

  /**
   * 生成预加载链接
   */
  private generatePreloadLinks(manifest?: Record<string, string[] | string>): string {
    if (!manifest) return '';

    const links: string[] = [];
    for (const [, files] of Object.entries(manifest)) {
      const fileList = Array.isArray(files) ? files : [files];
      for (const file of fileList) {
        if (file.endsWith('.js')) {
          links.push(`<link rel="modulepreload" href="/${file}" />`);
        } else if (file.endsWith('.css')) {
          links.push(`<link rel="stylesheet" href="/${file}" />`);
        }
      }
    }

    return links.join('\n  ');
  }

  /**
   * 创建流式 SSR HTML 文档
   */
  private createStreamingSSRHTML(options: {
    html: string;
    url: string;
    context: HtmlRenderContext;
    helmet?: HelmetSections;
    preloadLinks: string;
    flightPayload?: SerializedFlightPayload | null;
    componentStyles?: string[];
    runtimeStyleLinks: string;
  }): string {
    const {
      html,
      url,
      context,
      helmet,
      preloadLinks,
      flightPayload,
      componentStyles = [],
      runtimeStyleLinks,
    } = options;

    const renderTime = context.renderTime;
    const componentStyleList = Array.from(new Set(componentStyles.filter(Boolean)));
    const hasComponentStyles = componentStyleList.length > 0;
    const serializedRouteData = this.escapeJsonForHtml(JSON.stringify(context.routeData ?? null));

    const flightDataScript = flightPayload
      ? `<script id="__RSC_FLIGHT__" type="application/json">${this.escapeJsonForHtml(
          JSON.stringify(flightPayload)
        )}</script>`
      : '';
    const serializedComponentStyles = this.escapeJsonForHtml(JSON.stringify(componentStyleList));

    return `<!DOCTYPE html>
<html lang="zh-CN"${helmet?.htmlAttributes?.toString() || ''}>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${helmet?.title?.toString() || '<title>React 19 Streaming SSR - Novel Rating</title>'}
  ${helmet?.meta?.toString() || '<meta name="description" content="React 19 流式服务端渲染的小说评分平台" />'}
  ${helmet?.link?.toString() || ''}
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="stylesheet" href="/ssr-styles.css" />
  <meta name="generator" content="React 19 Streaming SSR" />
  <meta name="render-mode" content="${context.renderMode || 'ssr'}" />
  <meta name="streaming-ssr" content="true" />
  <meta name="rsc-component-styles" content="${hasComponentStyles ? 'available' : 'runtime-scan'}" />
  ${preloadLinks}
  ${helmet?.style?.toString() || ''}
  ${runtimeStyleLinks}
</head>
<body${helmet?.bodyAttributes?.toString() || ''}>
  <div id="root">${html}</div>
  <script>
    window.__STREAMING_SSR__ = true;
    window.__RENDER_TIME__ = '${renderTime}';
    window.__ISR_MODE__ = '${context.renderMode}';
    window.__RENDER_STRATEGY__ = '${context.strategy}';
    window.__CURRENT_PATH__ = '${url}';
    window.__FALLBACK_USED__ = ${context.fallbackUsed || false};
    window.__RSC_COMPONENT_STYLES__ = ${serializedComponentStyles};
    window.__RSC_COMPONENT_STYLE_ERROR__ = ${Boolean(
      context.rscStylesMissing || !hasComponentStyles
    )};
    window.__ROUTE_DATA__ = ${serializedRouteData};
    
    console.log('🚀 React 19 Streaming SSR 客户端初始化:', {
      streamingSSR: true,
      renderTime: '${renderTime}',
      renderMode: '${context.renderMode}',
      strategy: '${context.strategy}',
      currentPath: '${url}'
    });
  </script>
  ${flightDataScript}
  <script type="module" src="/src/entry.tsx"></script>
  ${helmet?.script?.toString() || ''}
</body>
</html>`;
  }

  /**
   * 转义 JSON 以安全嵌入 HTML
   */
  private escapeJsonForHtml(value: string): string {
    return value.replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  }
}
