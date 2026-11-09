/** Platform bindings and background-task scheduling for one exact Request object. */
export interface EdgeContext<Env extends object = Record<string, unknown>> {
  readonly env: Env;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

// Share the registry across the bundled adapter and the source runtime entry.
// This is a weak request registry, never an ambient "current request" pointer.
const registryKey = Symbol.for('@novel-isr/engine/request-edge-context/v1');
const registryHost = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<Request, EdgeContext<object>>;
};
const contexts = (registryHost[registryKey] ??= new WeakMap<Request, EdgeContext<object>>());

/** @internal Adapters bind the incoming request before invoking application code. */
export function bindEdgeContext(request: Request, context: EdgeContext<object>): void {
  contexts.set(request, context);
}

/**
 * Get platform context for the exact Request received by the handler.
 * Returns undefined outside a supported adapter, including for request.clone().
 * Pass the original Request (or the context itself) into deferred work explicitly.
 * Entries remain available after fetch returns for streams and waitUntil tasks;
 * weak ownership releases them when the Request is no longer reachable.
 * Context is never attached to request properties or serialized into responses.
 */
export function getEdgeContext<Env extends object = Record<string, unknown>>(
  request: Request
): EdgeContext<Env> | undefined {
  return contexts.get(request) as EdgeContext<Env> | undefined;
}
