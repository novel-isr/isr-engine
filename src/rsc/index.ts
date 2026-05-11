/**
 * isr-engine RSC 公共入口
 *
 * 职责边界：
 *   - Flight 编解码 / client & server reference / "use client" & "use server"
 *     指令识别 / client manifest / CSS 侧效  → 完全由 `@vitejs/plugin-rsc` 承担
 *   - 本模块只暴露 engine 级别的增量能力，供站点 Server Component / Server Action 消费：
 *       1) `revalidatePath` / `revalidateTag` —— 缓存失效信号分发
 *       2) `cacheTag` + AsyncLocalStorage 作用域 —— 渲染期声明本次响应关联的 tag
 *       3) Server Actions 元数据 registry —— 便于调试面板 / 指标
 */

export {
  revalidatePath,
  revalidateTag,
  registerInvalidator,
  RevalidationError,
  type RevalidateInvalidator,
} from './revalidate';

export {
  cacheTag,
  collectTags,
  runWithTagStore,
  debugTagStore,
  markUncacheable,
  isUncacheable,
} from './cacheTag';

export {
  serverActionsRegistry,
  createServerAction,
  ServerActionUtils,
  type ServerActionMetadata,
  type ServerActionHandler,
} from './ServerActions';

export {
  SERVER_ACTION_ENDPOINT,
  LEGACY_SERVER_ACTION_ENDPOINT,
  getServerActionEndpointCandidates,
  isLegacyServerActionEndpoint,
  shouldSkipServerActionEndpointRetry,
} from './constants';

export { getI18n, getI18nLocale, getCurrentI18n, runWithI18n } from './i18n';
export type { I18nParams, Translate } from './i18n';

// A/B testing：在 Server Component 里读 variant（轻量；不引入 express 类型）
// ABVariantMiddleware 在 Node express 层挂；本 helper 只读 RequestContext.flags
export { getVariant } from '../middlewares/abVariantContext';
export {
  getRequestContext,
  getTraceId,
  getRequestId,
  getAnonId,
  getUserId,
  getExperiments,
} from '../context/RequestContext';
