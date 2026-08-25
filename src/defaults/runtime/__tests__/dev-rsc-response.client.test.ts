import { createFromFetch } from 'react-server-dom-webpack/client.edge';
import { describe, expect, it, vi } from 'vitest';

import { observeDevRscResponse } from '../dev-rsc-response.client';

const rscClientOptions = {
  serverConsumerManifest: {
    moduleMap: {},
    serverModuleMap: {},
    moduleLoading: null,
  },
};

async function waitForUnhandledRejectionTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('development RSC response observation', () => {
  it('preserves the byte stream and resolves completion after the consumer observes EOF', async () => {
    const encoder = new TextEncoder();
    let close!: () => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('flight'));
        close = () => controller.close();
      },
    });
    const original = new Response(source, {
      status: 201,
      headers: { 'content-type': 'text/x-component' },
    });
    const observation = observeDevRscResponse(original);
    const completed = vi.fn();
    void observation.completed.then(completed);
    const reader = observation.response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('flight');
    expect(completed).not.toHaveBeenCalled();

    close();
    expect((await reader.read()).done).toBe(true);
    await observation.completed;

    expect(completed).toHaveBeenCalledOnce();
    expect(observation.response.status).toBe(201);
    expect(observation.response.headers.get('content-type')).toBe('text/x-component');
    expect(observation.original).toBe(original);
  });

  it('propagates stream failure to both React and the completion observer', async () => {
    const failure = new Error('flight failed');
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure);
        },
      })
    );
    const observation = observeDevRscResponse(original);

    await expect(observation.response.text()).rejects.toBe(failure);
    await expect(observation.completed).rejects.toBe(failure);
  });

  it('handles completion rejection immediately when Flight fails before root parsing returns', async () => {
    const failure = new Error('flight failed before root');
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure);
        },
      })
    );
    const unhandled: Promise<unknown>[] = [];
    const onUnhandled = (_reason: unknown, promise: Promise<unknown>) => unhandled.push(promise);
    process.on('unhandledRejection', onUnhandled);

    try {
      const observation = observeDevRscResponse(original);
      const root = createFromFetch(Promise.resolve(observation.response), rscClientOptions);

      await expect(Promise.resolve(root)).rejects.toBe(failure);
      await waitForUnhandledRejectionTurn();

      expect(unhandled).not.toContain(observation.completed);
      await expect(observation.completed).rejects.toBe(failure);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('handles completion rejection immediately when the Flight consumer cancels', async () => {
    const cancellation = new Error('Flight consumer cancelled');
    let sourceCancelled: unknown;
    const original = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          sourceCancelled = reason;
        },
      })
    );
    const unhandled: Promise<unknown>[] = [];
    const onUnhandled = (_reason: unknown, promise: Promise<unknown>) => unhandled.push(promise);
    process.on('unhandledRejection', onUnhandled);

    try {
      const observation = observeDevRscResponse(original);
      await observation.response.body!.cancel(cancellation);
      await waitForUnhandledRejectionTurn();

      expect(unhandled).not.toContain(observation.completed);
      expect(sourceCancelled).toBe(cancellation);
      await expect(observation.completed).rejects.toBe(cancellation);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
