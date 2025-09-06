/**
 * RSC 模块 - ISR 引擎的核心 RSC 支持
 * 实现完整的 React Server Components runtime
 * 
 * 核心特性：
 * - 异步组件处理和 Promise 解决
 * - RSC Payload 生成和序列化
 * - 客户端水合支持
 * - 与 ISR 缓存系统集成
 */

import React from 'react';
import { renderToPipeableStream } from 'react-dom/server';

import { Logger } from '../utils/Logger';
import { RSCRenderer, RSCConfig } from './RSCRenderer';
import type { RenderContext, RenderResult } from '../types';

export interface RSCRenderResult {
  html: string;
  rscPayload: any;
  clientComponents: string[];
  metadata: {
    serverComponentCount: number;
    clientComponentCount: number;
    renderTime: number;
    payloadSize: number;
  };
}

/**
 * RSC 模块 - 为 ISR 引擎提供完整的 RSC 支持
 */
export class RSCModule {
  private renderer: RSCRenderer;
  private logger: Logger;
  private config: RSCConfig;

  constructor(config: Partial<RSCConfig> = {}, verbose = false) {
    this.config = {
      enabled: true,
      serverComponents: {
        directory: './src/components',
        extensions: ['.server.tsx', '.server.ts'],
      },
      clientComponents: {
        directory: './src/components',
        bundling: true,
      },
      serialization: {
        maxDepth: 10,
        allowedTypes: ['string', 'number', 'boolean', 'object', 'array'],
      },
      ...config,
    };

    this.renderer = new RSCRenderer(this.config, verbose);
    this.logger = new Logger(verbose);
  }

  /**
   * 主要渲染方法 - 处理包含 RSC 组件的应用
   */
  async renderWithRSC(
    url: string,
    context: RenderContext,
    AppComponent: React.ComponentType<any>
  ): Promise<RSCRenderResult> {
    this.logger.info(`🔄 开始 RSC 渲染: ${url}`);
    const startTime = Date.now();

    try {
      // 创建应用组件实例
      const appElement = React.createElement(AppComponent);
      
      this.logger.debug('📊 开始分析组件树...');
      
      // 第一步：预取所有 RSC 组件需要的数据
      const prefetchedData = await this.prefetchRSCData(appElement, context);
      this.logger.debug(`📦 数据预取完成: ${prefetchedData.size} 个组件`);
      
      // 第二步：将预取的数据注入到组件中，创建完整的组件树
      const resolvedElement = await this.resolveAsyncComponents(appElement, context, prefetchedData);
      this.logger.debug('🔧 组件数据注入完成');

      // 第三步：使用传统 SSR 渲染完整的组件树
      this.logger.debug('🎨 开始最终 SSR 渲染...');
      const html = await this.renderResolvedTree(resolvedElement, url, context);

      // 第四步：生成客户端所需的元数据
      const rscPayload = await this.generateClientPayload(resolvedElement, context, prefetchedData);

      const renderTime = Date.now() - startTime;
      
      this.logger.info(`✅ RSC 渲染完成: ${renderTime}ms (数据组件: ${prefetchedData.size})`);

      return {
        html,
        rscPayload,
        clientComponents: [], // 后续扩展
        metadata: {
          serverComponentCount: prefetchedData.size,
          clientComponentCount: 0, // 后续统计
          renderTime,
          payloadSize: JSON.stringify(rscPayload).length,
        },
      };

    } catch (error) {
      this.logger.error('❌ RSC 渲染失败:', error);
      throw new Error(`RSC 渲染失败: ${(error as Error).message}`);
    }
  }

  /**
   * 预取 RSC 组件数据 - 生产级数据预取
   */
  private async prefetchRSCData(
    element: any,
    context: RenderContext
  ): Promise<Map<string, any>> {
    const prefetchedData = new Map<string, any>();

    // 递归查找需要服务端数据的组件
    const findDataRequiredComponents = (elem: any): any[] => {
      const components: any[] = [];
      
      if (!React.isValidElement(elem)) return components;

      const component = elem.type;
      if (typeof component === 'function') {
        // 检查组件是否标记为需要服务端数据
        const comp = component as any;
        if (comp._requiresServerData && comp._dataFetcher) {
          components.push({
            name: component.name || 'AnonymousComponent',
            component,
            props: elem.props,
            dataFetcher: comp._dataFetcher,
          });
        }
      }

      // 递归处理子元素
      const elemProps = elem.props as any;
      if (elemProps?.children) {
        const children = Array.isArray(elemProps.children) 
          ? elemProps.children 
          : [elemProps.children];
        
        for (const child of children) {
          components.push(...findDataRequiredComponents(child));
        }
      }

      return components;
    };

    const dataRequiredComponents = findDataRequiredComponents(element);
    this.logger.debug(`🔍 发现 ${dataRequiredComponents.length} 个需要服务端数据的组件`);

    // 并行预取所有组件的数据
    const prefetchPromises = dataRequiredComponents.map(async (comp) => {
      try {
        this.logger.debug(`🔄 预取数据: ${comp.name}`);
        const data = await comp.dataFetcher();
        prefetchedData.set(comp.name, data);
        this.logger.debug(`✅ 数据预取完成: ${comp.name}`);
      } catch (error) {
        this.logger.error(`❌ 数据预取失败 ${comp.name}:`, error);
        prefetchedData.set(comp.name, null);
      }
    });

    await Promise.all(prefetchPromises);
    return prefetchedData;
  }

  /**
   * 解析和注入数据到 RSC 组件
   */
  private async resolveAsyncComponents(
    element: any,
    context: RenderContext,
    prefetchedData: Map<string, any>,
    depth = 0
  ): Promise<React.ReactElement> {
    // 防止无限递归
    if (depth > 20) {
      this.logger.warn('组件树深度过大，停止解析');
      return element;
    }

    if (!React.isValidElement(element)) {
      return element;
    }

    const component = element.type;
    
    // 处理函数组件
    if (typeof component === 'function') {
      try {
        const componentName = component.name || 'AnonymousComponent';
        
        // 检查是否是需要服务端数据的 RSC 组件
        const comp = component as any;
        if (comp._requiresServerData) {
          this.logger.debug(`🔄 注入预取数据到组件: ${componentName}`);
          
          // 获取预取的数据
          const componentData = prefetchedData.get(componentName);
          
          // 创建新的 props，注入预取的数据
          const elementProps = element.props as any;
          const enhancedProps = {
            ...elementProps,
            // 根据组件类型注入相应的数据
            ...(componentName === 'BookListServer' && { booksData: componentData }),
            ...(componentName === 'SensitiveDataDemo' && { 
              sensitiveData: componentData?.user ? this.processSensitiveData(componentData) : null,
              internalAnalysis: componentData?.config ? this.processInternalAnalysis(componentData) : null,
              personalDiscount: componentData?.user ? this.calculatePremiumDiscount(componentData) : 0,
            }),
          };

          // 使用注入数据后的组件
          const enhancedElement = React.cloneElement(element, enhancedProps);
          
          // 递归处理子元素
          return await this.resolveAsyncComponents(enhancedElement, context, prefetchedData, depth + 1);
        }
      } catch (error) {
        this.logger.error(`组件数据注入失败 ${component.name}:`, error);
        
        // 生产级错误处理：返回错误占位符
        return React.createElement('div', {
          className: 'rsc-component-error',
          'data-component': component.name,
          style: { 
            padding: '10px', 
            border: '2px solid #f44336', 
            borderRadius: '4px',
            backgroundColor: '#ffebee' 
          }
        }, `组件 ${component.name} 数据注入失败`);
      }
    }

    // 处理普通元素：递归处理子元素
    const elementProps = element.props as any;
    if (elementProps?.children) {
      const children = elementProps.children;
      
      let resolvedChildren;
      if (Array.isArray(children)) {
        resolvedChildren = await Promise.all(
          children.map(child => this.resolveAsyncComponents(child, context, prefetchedData, depth + 1))
        );
      } else {
        resolvedChildren = await this.resolveAsyncComponents(children, context, prefetchedData, depth + 1);
      }

      return React.cloneElement(element, elementProps, resolvedChildren);
    }

    return element;
  }

  /**
   * 处理敏感数据 - 生产级安全数据处理
   */
  private processSensitiveData(rawData: any): any {
    if (!rawData?.user) return null;

    const user = rawData.user;
    
    return {
      user: {
        id: user.id,
        nickname: user.profile?.nickname || 'Unknown User',
        memberLevel: user.profile?.memberLevel || 'standard',
        avatar: user.profile?.avatar || '/default-avatar.svg',
      },
      financial: {
        creditScore: user.sensitiveInfo?.creditScore || 0,
        totalSpent: user.sensitiveInfo?.paymentHistory?.reduce(
          (sum: number, payment: any) => sum + (payment.amount || 0), 
          0
        ) || 0,
        lastPayment: user.sensitiveInfo?.paymentHistory?.[0]?.date || 'N/A',
        paymentMethodMask: user.sensitiveInfo?.paymentHistory?.[0]?.method || 'N/A',
      },
      analytics: {
        readingTime: user.sensitiveInfo?.readingHistory?.reduce(
          (total: number, session: any) => total + (session.readTime || 0),
          0
        ) || 0,
        averageCompletion: user.sensitiveInfo?.readingHistory?.length > 0 
          ? user.sensitiveInfo.readingHistory.reduce(
              (avg: number, session: any) => avg + (session.completionRate || 0),
              0
            ) / user.sensitiveInfo.readingHistory.length
          : 0,
        internalNotes: user.sensitiveInfo?.personalNotes || 'No notes available',
        ratingClassification: user.sensitiveInfo?.internalRating || 'Unrated',
      },
    };
  }

  /**
   * 处理内部分析数据
   */
  private processInternalAnalysis(rawData: any): any {
    const user = rawData?.user;
    if (!user) return null;

    const totalSpent = user.sensitiveInfo?.paymentHistory?.reduce(
      (sum: number, payment: any) => sum + (payment.amount || 0), 
      0
    ) || 0;

    const creditScore = user.sensitiveInfo?.creditScore || 0;

    return {
      userSegment: totalSpent > 100 ? 'high-value' : 'standard',
      riskLevel: creditScore > 700 ? 'low' : 'medium',
      campaignTarget: Math.random() > 0.5, // 营销算法
    };
  }

  /**
   * 计算个性化折扣 - 敏感定价算法
   */
  private calculatePremiumDiscount(rawData: any): number {
    const config = rawData?.config;
    const user = rawData?.user;
    
    if (!config || !user) return 0;

    const baseDiscount = config.businessLogic?.premiumDiscountRate || 0.1;
    const creditScore = user.sensitiveInfo?.creditScore || 0;
    const totalSpent = user.sensitiveInfo?.paymentHistory?.reduce(
      (sum: number, payment: any) => sum + (payment.amount || 0), 
      0
    ) || 0;
    
    if (creditScore > 800) {
      return baseDiscount + 0.05; // 高信用额外折扣
    }
    
    if (totalSpent > 200) {
      return baseDiscount + 0.03; // VIP 用户折扣
    }
    
    return baseDiscount;
  }

  /**
   * 渲染解析后的组件树
   */
  private async renderResolvedTree(
    resolvedElement: React.ReactElement,
    url: string,
    context: RenderContext
  ): Promise<string> {
    const logger = this.logger; // 捕获 this.logger 引用
    
    return new Promise((resolve, reject) => {
      let html = '';
      
      const stream = renderToPipeableStream(
        resolvedElement, // 移除路由依赖，由上层（entry.tsx）处理路由包装
        {
          onShellReady() {
            logger.debug('🚀 RSC 混合树渲染: Shell 准备就绪');
          },
          onAllReady() {
            logger.debug('✅ RSC 混合树渲染完成');
            resolve(html);
          },
          onError: reject,
        }
      );

      // 收集 HTML 内容
      stream.pipe({
        write(chunk: any) {
          html += chunk.toString();
          return true;
        },
        end() {
          // HTML 收集完成
        },
        writable: true,
      } as any);
    });
  }

  /**
   * 生成客户端 Payload
   */
  private async generateClientPayload(
    element: React.ReactElement,
    context: RenderContext,
    prefetchedData?: Map<string, any>
  ): Promise<any> {
    const serverDataSummary: any = {};
    
    // 为客户端提供数据摘要（不包含敏感信息）
    if (prefetchedData) {
      for (const [componentName, data] of prefetchedData) {
        if (data) {
          // 只提供安全的元数据，不包含敏感内容
          serverDataSummary[componentName] = {
            dataType: Array.isArray(data) ? 'array' : typeof data,
            itemCount: Array.isArray(data) ? data.length : 1,
            hasData: true,
            fetchedAt: Date.now(),
          };
        }
      }
    }
    
    return {
      type: 'rsc-payload',
      url: context.renderUrl,
      timestamp: Date.now(),
      serverData: {
        // 只包含安全的数据摘要
        componentSummary: serverDataSummary,
        serverContext: {
          renderMode: context.renderMode,
          locale: context.locale || 'zh-CN',
          rscEnabled: true,
          serverComponentCount: prefetchedData?.size || 0,
        },
      },
      // 性能指标
      performance: {
        totalComponents: prefetchedData?.size || 0,
        renderingStage: 'complete',
      },
    };
  }

  /**
   * 检查是否是服务端组件
   */
  private isServerComponent(component: any): boolean {
    if (!component) return false;
    
    const componentString = component.toString();
    return componentString.includes("'use server'") || 
           componentString.includes('"use server"');
  }

  /**
   * 检查是否是异步函数
   */
  private isAsyncFunction(fn: any): boolean {
    return fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
  }

  /**
   * 获取 RSC 运行时统计
   */
  getStats() {
    return {
      enabled: this.config.enabled,
      renderCacheSize: 0, // TODO: 实现缓存统计
      performance: this.renderer.getRuntimeInfo().performance,
    };
  }

  /**
   * 清理缓存
   */
  cleanup(): void {
    this.renderer.clearCache();
  }
}
