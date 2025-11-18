/**
 * RSC 发现器 - 负责从已注册的 RSC 组件生成实例信息
 * 职责：单一 - 仅负责发现逻辑，不涉及数据获取或注入
 * 策略：不依赖执行组件函数，而是直接利用静态注册信息
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RSCComponentInstance {
  componentName: string;
  componentId: string;
  dataFetcher: (props: any) => Promise<any>;
  requiresServerData: boolean;
  defaultProps?: Record<string, any>;
}

export class RSCDiscoverer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registeredComponents: Map<string, any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registeredComponents: Map<string, any>) {
    this.registeredComponents = registeredComponents;
  }

  /**
   * 从已注册的 RSC 组件生成实例信息
   * 不需要执行组件函数，直接从注册表生成
   */
  discoverInstances(): RSCComponentInstance[] {
    const instances: RSCComponentInstance[] = [];

    for (const [componentName, Component] of this.registeredComponents) {
      // 检查组件是否标记为 RSC
      if (Component._isRSCComponent && Component._dataFetcher) {
        const instance: RSCComponentInstance = {
          componentName,
          componentId: `rsc-${componentName}-${Date.now()}`,
          dataFetcher: Component._dataFetcher,
          requiresServerData: Component._requiresServerData ?? true,
          defaultProps: this.getDefaultPropsForComponent(componentName),
        };

        instances.push(instance);

        console.log(`🔍 [RSCDiscoverer] 发现 RSC 组件: ${componentName}`, {
          requiresServerData: instance.requiresServerData,
          defaultProps: instance.defaultProps,
        });
      }
    }

    console.log(`📦 [RSCDiscoverer] 发现完成: ${instances.length} 个 RSC 组件实例`);
    return instances;
  }

  /**
   * 获取组件的默认 Props
   * 这里定义已知组件的默认 Props
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getDefaultPropsForComponent(componentName: string): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultPropsMap: Record<string, Record<string, any>> = {
      BookListServer: {
        category: '奇幻',
        limit: 3,
      },
      SensitiveDataDemo: {
        userId: 1,
      },
    };

    return defaultPropsMap[componentName] || {};
  }
}
