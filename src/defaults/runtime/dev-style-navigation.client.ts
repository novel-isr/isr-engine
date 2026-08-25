import type { DevStyleRegistry } from './dev-style-registry.client';

export type DevStyleNavigationResult<T> =
  | { status: 'applied'; value: T; generation: number | undefined }
  | { status: 'superseded' };

export interface DevStyleNavigationLifecycle {
  register(registry: DevStyleRegistry): () => void;
  run<T, R>(
    operation: () => Promise<T>,
    apply: (value: T, generation: number | undefined) => R
  ): Promise<DevStyleNavigationResult<R>>;
  commitTree(generation: number): void;
  complete(generation: number): void;
}

export interface DevStyleNavigationLifecycleOptions {
  enabled?: boolean;
}

export function createDevStyleNavigationLifecycle(
  options: DevStyleNavigationLifecycleOptions = {}
): DevStyleNavigationLifecycle {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return {
      register: () => () => {},
      async run(operation, apply) {
        const value = await operation();
        return { status: 'applied', value: apply(value, undefined), generation: undefined };
      },
      commitTree: () => {},
      complete: () => {},
    };
  }

  let nextGeneration = 0;
  let latestResolvedGeneration = 0;
  let registry: DevStyleRegistry | undefined;
  const pendingGenerations = new Set<number>([0]);

  const complete = (generation: number) => {
    for (const pending of pendingGenerations) {
      if (pending <= generation) pendingGenerations.delete(pending);
    }
  };

  return {
    register(nextRegistry) {
      registry = nextRegistry;
      for (const generation of pendingGenerations) nextRegistry.beginRscUpdate(generation);
      return () => {
        if (registry === nextRegistry) registry = undefined;
      };
    },

    async run(operation, apply) {
      const generation = ++nextGeneration;
      pendingGenerations.add(generation);
      registry?.beginRscUpdate(generation);

      let value: Awaited<ReturnType<typeof operation>>;
      try {
        value = await operation();
      } catch (error) {
        pendingGenerations.delete(generation);
        registry?.abortRscUpdate(generation);
        throw error;
      }

      if (generation < latestResolvedGeneration) {
        pendingGenerations.delete(generation);
        registry?.abortRscUpdate(generation);
        return { status: 'superseded' };
      }

      latestResolvedGeneration = generation;
      return { status: 'applied', value: apply(value, generation), generation };
    },

    commitTree(generation) {
      if (registry) registry.reconcileDocumentStyles(generation);
      else complete(generation);
    },

    complete,
  };
}

const devStyleNavigationLifecycle = createDevStyleNavigationLifecycle({
  enabled: import.meta.env.DEV,
});

export const registerDevStyleRegistry = devStyleNavigationLifecycle.register;
export const runWithDevStyleNavigation = devStyleNavigationLifecycle.run;
export const commitDevStyleTree = devStyleNavigationLifecycle.commitTree;
export const completeDevStyleNavigation = devStyleNavigationLifecycle.complete;
