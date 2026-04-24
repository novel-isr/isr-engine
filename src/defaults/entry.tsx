/**
 * 浏览器入口（engine 内置 wrapper，**永远是** plugin-rsc 的 client env 入口）
 *
 * 自动加载用户 src/entry.tsx 的 default export 并应用其中的 FaaS hooks。
 *
 *   形状 A · FaaS 配置（推荐）：
 *     export default {
 *       beforeHydrate: () => initSentry(),
 *       onNavigate: (url) => analytics.pageview(url.pathname),
 *       onActionError: (err, id) => console.error('action failed', id, err),
 *     };
 *
 *   形状 B · 不写 src/entry.tsx（engine 默认空 hooks）—— 不需要任何代码
 *
 * 不支持"完整 handler 覆盖"模式 —— 因为浏览器水合 / Server Action / 导航
 * 拦截这些细节高度耦合 react-server-dom-webpack 的内部 API，用户重写出错率
 * 极高且无收益。需要扩展时使用 hooks 即可。
 */
import { defineClientEntry, type ClientEntryHooks } from './runtime/defineClientEntry';
// @ts-expect-error - @app/_client-config 由 createIsrPlugin 注入
import userConfig from '@app/_client-config';

defineClientEntry((userConfig ?? {}) as ClientEntryHooks);
