export function isRenderCancellation(signal: AbortSignal | undefined, error: unknown): boolean {
  // React receives this same reason through its render signal.
  return signal?.aborted === true && error === signal.reason;
}

export function createRenderErrorHandler(signal: AbortSignal | undefined) {
  return (error: unknown): void => {
    if (!isRenderCancellation(signal, error)) console.error(error);
  };
}
