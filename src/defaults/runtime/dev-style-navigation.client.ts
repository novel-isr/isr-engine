import type { DevStyleRegistry } from './dev-style-registry.client';

export type DevStyleNavigationResult<R, T = R> =
  | { status: 'applied'; value: R; generation: number | undefined }
  | { status: 'superseded'; operationValue?: T };

export interface DevStyleNavigationLifecycle {
  register(registry: DevStyleRegistry): () => void;
  run<T, R>(
    operation: () => Promise<T>,
    apply: (value: T, generation: number | undefined) => R
  ): Promise<DevStyleNavigationResult<R, T>>;
  prepareTree(generation: number, styleIds: Iterable<string>): void;
  commitTree(generation: number, styleIds: Iterable<string>): void;
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
      prepareTree: () => {},
      commitTree: () => {},
      complete: () => {},
    };
  }

  let nextGeneration = 0;
  let latestResolvedGeneration = 0;
  let registry: DevStyleRegistry | undefined;
  const pendingGenerations = new Set<number>([0]);
  const pendingStyleIds = new Map<number, string[]>();

  const complete = (generation: number) => {
    for (const pending of pendingGenerations) {
      if (pending <= generation) pendingGenerations.delete(pending);
    }
    for (const pending of pendingStyleIds.keys()) {
      if (pending <= generation) pendingStyleIds.delete(pending);
    }
  };

  return {
    register(nextRegistry) {
      registry = nextRegistry;
      for (const generation of pendingGenerations) {
        nextRegistry.beginRscUpdate(generation);
        const styleIds = pendingStyleIds.get(generation);
        if (styleIds) nextRegistry.declareRscStyles(generation, styleIds);
      }
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
        if (generation < latestResolvedGeneration) return { status: 'superseded' };
        throw error;
      }

      if (generation < latestResolvedGeneration) {
        pendingGenerations.delete(generation);
        registry?.abortRscUpdate(generation);
        return { status: 'superseded', operationValue: value };
      }

      latestResolvedGeneration = generation;
      return { status: 'applied', value: apply(value, generation), generation };
    },

    prepareTree(generation, styleIds) {
      const declared = Array.from(styleIds);
      pendingStyleIds.set(generation, declared);
      registry?.declareRscStyles(generation, declared);
    },

    commitTree(generation, styleIds) {
      const declared = Array.from(styleIds);
      if (registry) {
        registry.declareRscStyles(generation, declared);
        registry.reconcileDocumentStyles(generation, declared);
      } else complete(generation);
    },

    complete,
  };
}

const devStyleNavigationLifecycle = createDevStyleNavigationLifecycle({
  enabled: import.meta.env.DEV,
});

export const registerDevStyleRegistry = devStyleNavigationLifecycle.register;
export const runWithDevStyleNavigation = devStyleNavigationLifecycle.run;
export const prepareDevStyleTree = devStyleNavigationLifecycle.prepareTree;
export const commitDevStyleTree = devStyleNavigationLifecycle.commitTree;
export const completeDevStyleNavigation = devStyleNavigationLifecycle.complete;
