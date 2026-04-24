export * from './ISRConfig';
export * from './ISRContext';
export * from './IRenderResult';
export * from './IRenderMetadata';
export * from './IHelmetData';
export * from './IFlightData';

// 兼容别名
export type { ISRConfig as NovelISRConfig } from './ISRConfig';
export type { ISRConfig as NovelSSRConfig } from './ISRConfig';

// 注意：虚拟模块类型声明在 virtual-modules.d.ts 中
// 消费者项目需要在 vite-env.d.ts 中添加：
// /// <reference types="@novel-isr/engine/virtual-modules" />
