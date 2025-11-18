/**
 * RSC Runtime - 核心 Flight 协议实现
 * 职责单一：管理已注册的 RSC 组件，预取并注入数据
 * 不依赖组件执行函数，规避 Hooks 冲突问题
 *
 * @eslint-disable @typescript-eslint/no-explicit-any
 */

import React, { ReactElement } from 'react';
import { FlightSerializer, FlightDeserializer } from './PlumberProtocol';

type StyleLoader = () => Promise<unknown>;

export interface RSCComponentMeta {
  name: string;
  isRSC: boolean;
  requiresServerData: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataFetcher?: (props: any) => Promise<any>;
  styleLoaders?: StyleLoader[];
}

export interface RSCRuntimeConfig {
  debug?: boolean;
  componentPaths?: string[];
}

export class RSCRuntime {
  private components: Map<string, RSCComponentMeta> = new Map();
  private styleLoaders: Map<string, StyleLoader[]> = new Map();
  private loadedStyleLoaders: WeakSet<StyleLoader> = new WeakSet();
  private pendingStylePromises: WeakMap<StyleLoader, Promise<void>> = new WeakMap();
  private recentComponentUsage: string[] = [];
  private serializer = new FlightSerializer();
  private deserializer = new FlightDeserializer();
  private config: RSCRuntimeConfig;

  constructor(config: RSCRuntimeConfig = {}) {
    this.config = {
      debug: false,
      componentPaths: [],
      ...config,
    };
  }

  /**
   * 注册 RSC 组件
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerComponent(Component: any): void {
    if (!Component) return;

    const componentName = Component.name || Component.displayName || 'Unknown';
    console.log(
      `📋 registerComponent 被调用: ${componentName}，有 _isRSCComponent 标记: ${!!Component._isRSCComponent}`
    );

    if (Component._isRSCComponent) {
      const normalizedStyleLoaders = this.normalizeStyleLoaders(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        Component._styleLoaders
      );
      const meta: RSCComponentMeta = {
        name: componentName,
        isRSC: true,
        requiresServerData: Component._requiresServerData ?? true,
        dataFetcher: Component._dataFetcher,
        styleLoaders: normalizedStyleLoaders.length > 0 ? normalizedStyleLoaders : undefined,
      };

      this.components.set(componentName, meta);
      console.log(
        `📋 已存储组件 "${componentName}" 到 this.components，当前大小: ${this.components.size}`,
        {
          isRSC: true,
          styleLoadersCount: normalizedStyleLoaders.length,
          hasDataFetcher: !!Component._dataFetcher,
        }
      );
      if (normalizedStyleLoaders.length > 0) {
        this.registerStyleLoader(componentName, normalizedStyleLoaders);
        console.log(
          `✅ 注册 RSC 组件: ${componentName}，样式加载器数量: ${normalizedStyleLoaders.length}`
        );
      } else {
        console.log(`✅ 注册 RSC 组件: ${componentName}，无样式加载器`);
      }
    }
  }

  /**
   * 自动发现 RSC 组件（从 React 树遍历）
   */
  async discoverRSCComponents(element: ReactElement): Promise<void> {
    console.log('🚀 开始静态注册 RSC 组件...');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discover = async (el: any): Promise<void> => {
      if (!el || typeof el !== 'object') return;

      if (React.isValidElement(el)) {
        const Component = el.type;
        if (Component && typeof Component === 'function') {
          this.registerComponent(Component);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((el.props as any)?.children) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const children = Array.isArray((el.props as any).children)
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (el.props as any).children
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              [(el.props as any).children];
          for (const child of children) {
            if (React.isValidElement(child)) {
              await discover(child);
            }
          }
        }
      }
    };

    await discover(element);

    console.log(`✅ RSC 组件注册完成: ${this.components.size} 个组件`);
    console.log('📋 已注册组件列表:');
    for (const [name, meta] of this.components) {
      console.log(`  - ${name} (需要数据: ${meta.requiresServerData})`);
    }
  }

  /**
   * 预取 RSC 数据 - 改进版本（不依赖 extractRSCInstances）
   *
   * 核心策略变化：
   * - 旧方式：执行组件函数来发现 RSC → 含 Hooks 的组件失败 → 链路断裂 → 返回 0 个组件
   * - 新方式：直接使用已注册的 RSC 组件列表 → 为每个组件调用 _dataFetcher → 避免 Hooks 问题
   *
   * 工作流程：
   * 1. 遍历 this.components（已注册的 RSC 组件）
   * 2. 获取每个组件的默认 Props
   * 3. 直接调用 _dataFetcher
   * 4. 返回数据映射表
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async prefetchRSCData(): Promise<Map<string, any>> {
    console.log('🔍 开始预取 RSC 组件数据（Flight 协议 - 改进版本）...');
    console.log(`📦 已注册 ${this.components.size} 个 RSC 组件`);

    const dataMap = new Map();

    // 关键改变：直接遍历已注册的组件，不执行任何组件函数
    for (const [componentName, meta] of this.components) {
      if (!meta.isRSC || !meta.dataFetcher) {
        console.log(`⚠️ 组件 ${componentName} 不是 RSC 或没有数据获取器，跳过`);
        continue;
      }

      try {
        // 获取该组件的默认 Props
        const defaultProps = this.getDefaultPropsForComponent(componentName);

        console.log(`🔄 开始预取 ${componentName} 数据...`);
        console.log(`📥 ${componentName} 默认 Props:`, defaultProps);

        // 直接调用 _dataFetcher（不执行组件函数）
        const data = await meta.dataFetcher(defaultProps);

        console.log(
          `✅ ${componentName} 数据预取成功，数据条数: ${Array.isArray(data) ? data.length : 'N/A'}`
        );

        dataMap.set(componentName, data);
      } catch (error) {
        console.error(`❌ ${componentName} 数据预取失败:`, error);
      }
    }

    console.log(`✅ RSC 数据预取完成: ${dataMap.size} 个组件成功预取数据`);
    return dataMap;
  }

  /**
   * 获取组件的默认 Props - 中心配置点
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getDefaultPropsForComponent(componentName: string): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultPropsMap: Record<string, any> = {
      BookListServer: {
        category: '奇幻',
        limit: 3,
      },
      SensitiveDataDemo: {
        userId: 1,
      },
    };

    const props = defaultPropsMap[componentName] || {};
    console.log(
      `📋 getDefaultPropsForComponent("${componentName}"): 返回 ${JSON.stringify(props)}`
    );
    return props;
  }

  /**
   * 将预取的数据注入到 RSC 组件的 props
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async injectRSCData(
    element: ReactElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataMap: Map<string, any>,
    depth = 0
  ): Promise<ReactElement> {
    if (depth === 0) {
      console.log('🔧 injectRSCData: 开始注入数据（Flight 协议）', {
        dataMapSize: dataMap.size,
        dataMapKeys: Array.from(dataMap.keys()),
      });

      // 📌 关键修复：记录所有在 dataMap 中的 RSC 组件（不管是否在树中）
      // 这确保样式加载器能够正确收集，即使组件不在当前的 React 树中
      const dataMapKeys = Array.from(dataMap.keys());
      console.log('🔧 记录所有预取了数据的 RSC 组件...', { dataMapKeys });

      for (const componentName of dataMapKeys) {
        const meta = this.components.get(componentName);
        console.log(`🔧 [DEBUG] 检查 ${componentName}: meta=${!!meta}, isRSC=${meta?.isRSC}`);

        if (meta && meta.isRSC) {
          this.recordComponentUsage(componentName);
          console.log(`🔧 ✅ 记录 RSC 组件使用: ${componentName}`);
        }
      }

      const recentlyUsed = this.getRecentlyUsedComponents();
      console.log(
        `🔧 injectRSCData depth=0: 记录完成，recentlyUsed=${JSON.stringify(recentlyUsed)}`
      );
    }

    if (!element) return element;

    const Component = element.type;
    const componentName =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Component as any)?.name ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Component as any)?.displayName ||
      String(Component);

    // 添加深度追踪日志
    if (typeof Component === 'function') {
      const meta = this.components.get(componentName);
      if (meta?.isRSC) {
        console.log(`  ${'  '.repeat(depth)}🔍 [深度${depth}] 检查 RSC 组件: ${componentName}`);
      }
    }

    // 检查是否是 RSC 组件
    if (typeof Component === 'function') {
      const meta = this.components.get(componentName);
      console.log(`  ${'  '.repeat(depth)}🔎 检查组件: ${componentName}`, {
        hasMeta: !!meta,
        isRSC: meta?.isRSC,
        inDataMap: dataMap.has(componentName),
        registeredComponentsSize: this.components.size,
      });

      // 如果是 RSC 组件且有数据，注入到 props
      if (meta && meta.isRSC && dataMap.has(componentName)) {
        console.log(`  ${'  '.repeat(depth)}✅ [RSC 数据注入] ${componentName}: 记录组件使用`, {
          hasData: dataMap.has(componentName),
          propName: this.getDataPropName(componentName),
        });
        // 注意：recordComponentUsage 可能已在 depth === 0 时被调用过
        // 但这里再次调用也没有影响（deduplicated by array logic）
        this.recordComponentUsage(componentName);
        const data = dataMap.get(componentName);
        const propName = this.getDataPropName(componentName);

        console.log(`  ${'  '.repeat(depth)}✅ 注入 ${componentName} 数据到 props.${propName}`, {
          dataLength: Array.isArray(data) ? data.length : typeof data,
        });

        return React.cloneElement(element, {
          ...element.props,
          [propName]: data,
        });
      } else if (meta && meta.isRSC) {
        console.log(
          `  ${'  '.repeat(depth)}⚠️ [RSC 未注入] ${componentName}: 数据未在 dataMap 中`,
          {
            isRSC: meta.isRSC,
            dataMapHasComponent: dataMap.has(componentName),
            dataMapKeys: Array.from(dataMap.keys()),
          }
        );
      }
    }

    // 递归处理 children
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((element.props as any)?.children) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const children = Array.isArray((element.props as any).children)
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (element.props as any).children
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [(element.props as any).children];

      const newChildren = await Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children.map(async (child: any) => {
          if (React.isValidElement(child)) {
            return this.injectRSCData(child, dataMap, depth + 1);
          }
          return child;
        })
      );

      return React.cloneElement(element, {
        ...element.props,
        children: newChildren,
      });
    }

    return element;
  }

  /**
   * 获取数据注入时的 prop 名称
   */
  private getDataPropName(componentName: string): string {
    const propMap: Record<string, string> = {
      BookListServer: 'booksData',
      SensitiveDataDemo: 'sensitiveData',
    };
    return propMap[componentName] || 'data';
  }

  /**
   * 使用 Flight 协议渲染（可选方法）
   */
  async renderToFlight(element: ReactElement): Promise<string> {
    if (this.config.debug) {
      console.log('🚀 开始 RSC Flight 渲染...');
    }

    this.resetRecentComponentUsage();

    // 1. 发现 RSC 组件
    await this.discoverRSCComponents(element);

    // 2. 预取数据
    const dataMap = await this.prefetchRSCData();

    // 3. 注入数据
    const elementWithData = await this.injectRSCData(element, dataMap);

    // 4. 序列化（如果需要）
    const result = this.serializer.serialize(elementWithData, {
      rscData: Object.fromEntries(dataMap),
    });

    // ✅ 使用新的 FlightStream API
    const flightPayload = result.chunks.join('\n');

    if (this.config.debug) {
      console.log(`✅ Flight 序列化完成: ${result.chunks.length} chunks`);
    }

    return flightPayload;
  }

  registerStyleLoader(componentName: string, loaders: StyleLoader | StyleLoader[]): void {
    const normalized = this.normalizeStyleLoaders(loaders);
    if (normalized.length === 0) {
      return;
    }

    const existingLoaders = this.styleLoaders.get(componentName) ?? [];
    const mergedLoaders: StyleLoader[] = [...existingLoaders];

    for (const loader of normalized) {
      if (!mergedLoaders.includes(loader)) {
        mergedLoaders.push(loader);
      }
    }

    this.styleLoaders.set(componentName, mergedLoaders);
  }

  async ensureComponentStyles(componentNames?: string[]): Promise<void> {
    if (typeof window === 'undefined') {
      return;
    }

    const targets = this.getStyleLoaderTargets(componentNames);
    console.log('🎨 RSCRuntime.ensureComponentStyles:', {
      requestedComponents: componentNames,
      targets,
      availableStyleLoaders: Array.from(this.styleLoaders.keys()),
      totalLoaders: this.styleLoaders.size,
    });

    if (targets.length === 0) {
      console.warn('⚠️ 没有找到需要加载样式的组件');
      return;
    }

    await Promise.all(
      targets.map(async componentName => {
        const loaders = this.styleLoaders.get(componentName);
        console.log(`🎨 检查组件 ${componentName} 的样式加载器:`, {
          hasLoaders: !!loaders,
          loaderCount: loaders?.length || 0,
        });

        if (!loaders || loaders.length === 0) {
          console.warn(`⚠️ 组件 ${componentName} 没有注册样式加载器`);
          return;
        }

        for (const loader of loaders) {
          await this.runStyleLoader(loader);
        }
      })
    );
  }

  getRecentlyUsedComponents(): string[] {
    const result = [...this.recentComponentUsage];
    console.log(`📌 getRecentlyUsedComponents: 返回数组长度 ${result.length}`, {
      components: result,
      internalArray: this.recentComponentUsage,
    });
    return result;
  }

  setRecentlyUsedComponents(componentNames: string[] = []): void {
    this.recentComponentUsage = Array.from(new Set(componentNames));
  }

  /**
   * 获取已注册的组件列表（用于调试）
   */
  getRegisteredComponents(): Map<string, RSCComponentMeta> {
    return this.components;
  }

  /**
   * 获取拥有样式加载器的组件名称
   */
  getComponentsWithStyleLoaders(): string[] {
    return Array.from(this.styleLoaders.keys());
  }

  private getStyleLoaderTargets(componentNames?: string[]): string[] {
    if (componentNames && componentNames.length > 0) {
      return Array.from(new Set(componentNames));
    }
    return this.getRecentlyUsedComponents();
  }

  private async runStyleLoader(loader: StyleLoader): Promise<void> {
    if (this.loadedStyleLoaders.has(loader)) {
      console.log('✅ 样式已加载，跳过');
      return;
    }

    const pending = this.pendingStylePromises.get(loader);
    if (pending) {
      console.log('⏳ 样式正在加载中，等待...');
      await pending;
      return;
    }

    const loadPromise = (async () => {
      try {
        console.log('🎨 开始加载样式...');
        await loader();
        this.loadedStyleLoaders.add(loader);
        console.log('✅ 样式加载成功');
      } catch (error) {
        console.warn('⚠️ RSC 样式加载失败:', error);
      } finally {
        this.pendingStylePromises.delete(loader);
      }
    })();

    this.pendingStylePromises.set(loader, loadPromise);
    await loadPromise;
  }

  private normalizeStyleLoaders(loaders?: StyleLoader | StyleLoader[] | null): StyleLoader[] {
    if (!loaders) {
      return [];
    }

    const array = Array.isArray(loaders) ? loaders : [loaders];
    return array.filter((loader): loader is StyleLoader => typeof loader === 'function');
  }

  private recordComponentUsage(componentName: string): void {
    if (!componentName) {
      console.log(`📌 recordComponentUsage: componentName 为空，跳过`);
      return;
    }

    const existingIndex = this.recentComponentUsage.indexOf(componentName);
    if (existingIndex !== -1) {
      this.recentComponentUsage.splice(existingIndex, 1);
    }

    this.recentComponentUsage.push(componentName);
    console.log(
      `📌 recordComponentUsage: 已添加 "${componentName}" 到数组，当前数组长度: ${this.recentComponentUsage.length}`,
      {
        currentArray: [...this.recentComponentUsage],
      }
    );
  }

  /**
   * 重置最近使用的组件列表（公开方法）
   */
  resetRecentComponentUsage(): void {
    this.recentComponentUsage = [];
  }
}

// 导出单例
export const rscRuntime = new RSCRuntime({ debug: false });
