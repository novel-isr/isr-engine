/**
 * Re-export shim —— 真实定义在 src/defaults/runtime/seo-runtime.ts
 *
 * 原因：defaults/ 在用户的 plugin-rsc 上下文里被打包；不能跨引 src/engine/。
 * 因此运行时类型 + 注入 helper 集中在 defaults/runtime/，这里仅做公共 API 转发。
 */
export type { PageSeoMeta } from '../../defaults/runtime/seo-runtime';
export { renderPageSeoMeta } from '../../defaults/runtime/seo-runtime';
