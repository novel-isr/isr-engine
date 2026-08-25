export interface DevRscResponseObservation {
  original: Response;
  response: Response;
  completed: Promise<void>;
}

export function observeDevRscResponse(original: Response): DevRscResponseObservation {
  if (!original.body) {
    return { original, response: original, completed: Promise.resolve() };
  }

  const reader = original.body.getReader();
  let resolveCompletion!: () => void;
  let rejectCompletion!: (reason: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // createFromFetch can reject or cancel before its caller obtains `completed`.
  // Handle that timing window now; the original promise remains rejected for the later await.
  void completed.catch(() => {});
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          queueMicrotask(resolveCompletion);
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        rejectCompletion(error);
      }
    },
    async cancel(reason) {
      rejectCompletion(reason);
      await reader.cancel(reason);
    },
  });
  const response = new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  return { original, response, completed };
}
