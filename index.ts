/**
 * @novel-isr/engine - 企业级增量静态再生引擎
 * 自动降级链: ISR → SSR → CSR
 * 对用户透明的智能渲染策略
 */

// === 核心 API ===
export { createNovelEngine, NovelEngine } from './engines/ISRFactory';

// === 类型定义 ===
export * from './types';

// === 配置系统 ===
export * from './config';

// === 渲染引擎 ===
export * from './engines';

// === 功能模块 ===
export * from './modules';

// === 工具类 ===
export * from './utils';

// === 默认导出 - 主要工厂函数 ===
export { createNovelEngine as default } from './engines/ISRFactory';
