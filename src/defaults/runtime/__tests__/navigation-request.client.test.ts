import { expect, it } from 'vitest';
import { createNavigationRequestLifecycle } from '../navigation-request.client';

it('aborts only pending navigation and suppresses its rejection', async () => {
  const lifecycle = createNavigationRequestLifecycle();
  let signal!: AbortSignal;
  const first = lifecycle.run(async current => {
    signal = current;
    await new Promise((_, reject) =>
      current.addEventListener('abort', () => reject(current.reason))
    );
  });
  await lifecycle.run(async current => expect(current.aborted).toBe(false));
  expect(signal.aborted).toBe(true);
  await expect(first).resolves.toBeUndefined();
});

it('keeps a settled response alive and rejects genuine failures', async () => {
  const lifecycle = createNavigationRequestLifecycle();
  let settled!: AbortSignal;
  await lifecycle.run(async signal => {
    settled = signal;
  });
  await expect(
    lifecycle.run(async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
  expect(settled.aborted).toBe(false);
});

it('does not let an older completion clear the latest controller', async () => {
  const lifecycle = createNavigationRequestLifecycle();
  let release!: () => void;
  const first = lifecycle.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      })
  );
  let latest!: AbortSignal;
  const second = lifecycle.run(signal => {
    latest = signal;
    return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
  });
  release();
  await first;
  await lifecycle.run(async () => {});
  expect(latest.aborted).toBe(true);
  await second;
});
