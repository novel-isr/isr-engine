import {
  createAutoServerHooks,
  composeAutoServerHooks,
  resolveSentryDsnFromEnv,
  type AutoServerCtx,
  type AutoServerHooks,
} from 'isr-engine/auto-observability';
import { createCoherentCacheStore, Logger, type ResponseCacheBackend } from 'isr-engine';
import { getEdgeContext, type EdgeContext } from 'isr-engine/runtime';

const factory: () => Promise<AutoServerHooks> = createAutoServerHooks;
const ctx: AutoServerCtx = { traceId: 'trace', startedAt: 1 };
const hooks: AutoServerHooks = composeAutoServerHooks([]);
const dsn: string | undefined = resolveSentryDsnFromEnv({});
declare const backend: ResponseCacheBackend;
const store = createCoherentCacheStore({ backend });
declare const spinner: ReturnType<ReturnType<typeof Logger.getInstance>['spin']>;
const prefix: string | (() => string) = spinner.prefixText;
const suffix: string | (() => string) = spinner.suffixText;
const labels: string[] = [prefix, suffix].map(text => (typeof text === 'function' ? text() : text));
// @ts-expect-error Generator labels must be resolved before use as strings.
const unresolved: string = spinner.prefixText;
spinner.prefixText = () => 'prefix';
spinner.suffixText = () => 'suffix';
spinner.color = false;
spinner.color = undefined;
// @ts-expect-error Ora does not accept true as a color.
spinner.color = true;
// @ts-expect-error Timestamps are numeric.
const invalid: AutoServerCtx = { traceId: 'trace', startedAt: 'yesterday' };
const edge: EdgeContext<{ token: string }> | undefined = getEdgeContext<{ token: string }>(
  new Request('https://consumer.test')
);
// @ts-expect-error Edge context lookup requires a Request.
getEdgeContext();
void [factory, ctx, hooks, dsn, store, invalid, labels, unresolved, edge];
