/**
 * Browser telemetry facade.
 *
 * Business code imports these functions for semantic product events, domain
 * errors, or custom performance measurements. The transport is installed by
 * the engine client entry from ssr.config.ts runtime.telemetry. Without an
 * installed transport these functions are deliberate no-ops, so shared modules
 * can import them safely during SSR/RSC evaluation.
 */

export type TelemetryLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface TelemetryUser {
  id?: string;
  tenantId?: string;
  segment?: string;
  traits?: Record<string, unknown>;
}

export interface TelemetryEventOptions {
  tags?: Record<string, string | number | boolean | null | undefined>;
}

export interface TelemetryCaptureOptions extends TelemetryEventOptions {
  level?: TelemetryLevel;
  source?: string;
  extra?: Record<string, unknown>;
  fingerprint?: readonly string[];
}

export interface TelemetryMeasureOptions extends TelemetryEventOptions {
  unit?: 'ms' | 's' | 'byte' | 'count' | 'ratio' | string;
  properties?: Record<string, unknown>;
}

export interface TelemetryRuntimeHandle {
  track(name: string, properties?: Record<string, unknown>, options?: TelemetryEventOptions): void;
  capture(error: unknown, options?: TelemetryCaptureOptions): void;
  measure(name: string, value: number, options?: TelemetryMeasureOptions): void;
  page(url?: URL | string): void;
  setUser(user: TelemetryUser | null): void;
  flush(): Promise<void> | void;
  shutdown(): void;
}

type PendingTelemetryCall = (handle: TelemetryRuntimeHandle) => void;

const MAX_PENDING_CALLS = 50;

let currentHandle: TelemetryRuntimeHandle | null = null;
let pendingCalls: PendingTelemetryCall[] = [];

export function track(
  name: string,
  properties?: Record<string, unknown>,
  options?: TelemetryEventOptions
): void {
  runOrQueue(handle => handle.track(name, properties, options));
}

export function capture(error: unknown, options?: TelemetryCaptureOptions): void {
  runOrQueue(handle => handle.capture(error, options));
}

export function measure(name: string, value: number, options?: TelemetryMeasureOptions): void {
  runOrQueue(handle => handle.measure(name, value, options));
}

export function page(url?: URL | string): void {
  runOrQueue(handle => handle.page(url));
}

export function setTelemetryUser(user: TelemetryUser | null): void {
  runOrQueue(handle => handle.setUser(user));
}

export function flushTelemetry(): Promise<void> | void {
  return currentHandle?.flush();
}

export function getTelemetry(): TelemetryRuntimeHandle | null {
  return currentHandle;
}

export function __setBrowserTelemetryHandle(handle: TelemetryRuntimeHandle): void {
  currentHandle = handle;
  const calls = pendingCalls;
  pendingCalls = [];
  for (const call of calls) {
    try {
      call(handle);
    } catch {
      /* telemetry facade must never break app startup */
    }
  }
}

export function __clearBrowserTelemetryHandle(handle: TelemetryRuntimeHandle): void {
  if (currentHandle === handle) currentHandle = null;
}

function runOrQueue(call: PendingTelemetryCall): void {
  if (currentHandle) {
    call(currentHandle);
    return;
  }
  if (!isBrowser()) return;
  pendingCalls.push(call);
  if (pendingCalls.length > MAX_PENDING_CALLS) {
    pendingCalls = pendingCalls.slice(-MAX_PENDING_CALLS);
  }
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
