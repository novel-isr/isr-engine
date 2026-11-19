type RevalidationMetricRecorder = (
  event: 'run' | 'failure',
  kind: 'path' | 'tag',
  target: string
) => void;

const RECORDER_KEY = Symbol.for('isr-engine:revalidation-metric-recorder');
const runtime = globalThis as typeof globalThis & {
  [RECORDER_KEY]?: RevalidationMetricRecorder;
};

/** The Node origin owns the metrics registry, including events from the separate Vite RSC graph. */
export function setRevalidationMetricRecorder(recorder: RevalidationMetricRecorder): void {
  runtime[RECORDER_KEY] = recorder;
}

export function recordRevalidationMetric(...args: Parameters<RevalidationMetricRecorder>): void {
  runtime[RECORDER_KEY]?.(...args);
}
