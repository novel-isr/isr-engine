/**
 * 可观测性 SDK 预制 hook adapters
 *
 * 服务端：
 *   import { createSentryServerHooks } from '@novel-isr/engine/adapters/observability';
 *   import { createDatadogServerHooks } from '@novel-isr/engine/adapters/observability';
 *   import { createOtelServerHooks } from '@novel-isr/engine/adapters/observability';
 *
 * 客户端：
 *   import { createSentryClientHooks } from '@novel-isr/engine/adapters/observability';
 */
export { createSentryServerHooks, type SentryServerHooksOptions } from './server/sentry';
export { createDatadogServerHooks, type DatadogServerHooksOptions } from './server/datadog';
export { createOtelServerHooks, type OtelServerHooksOptions } from './server/otel';
export { createSentryClientHooks, type SentryClientHooksOptions } from './client/sentry';
export type { ServerObservabilitySdk, ClientObservabilitySdk } from './types';
