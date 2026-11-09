/** Owns route requests only; prefetches and server actions have independent consumers. */
export function createNavigationRequestLifecycle(): {
  run(operation: (signal: AbortSignal) => Promise<void>): Promise<void>;
} {
  let pending: AbortController | undefined;
  return {
    async run(operation) {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        await operation(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        // A completed payload can still own deferred React resources. Do not abort it.
        if (pending === controller) pending = undefined;
      }
    },
  };
}
