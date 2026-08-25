import type { DevStyleRegistry } from './dev-style-registry.client';

export type DevStyleNavigationResult<R, T = R> =
  | { status: 'applied'; value: R; generation: number | undefined }
  | { status: 'superseded'; operationValue?: T };

export interface DevStyleNavigationLifecycle {
  register(registry: DevStyleRegistry): () => void;
  run<T, R>(
    operation: (generation: number | undefined) => Promise<T>,
    apply: (value: T, generation: number | undefined) => R,
    prepare?: (value: T, generation: number | undefined) => void | Promise<void>
  ): Promise<DevStyleNavigationResult<R, T>>;
  prepareTree(generation: number, styleIds: Iterable<string>): Promise<void>;
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
        const value = await operation(undefined);
        return { status: 'applied', value: apply(value, undefined), generation: undefined };
      },
      prepareTree: async () => {},
      commitTree: () => {},
      complete: () => {},
    };
  }

  let nextGeneration = 0;
  let latestResolvedGeneration = 0;
  let registry: DevStyleRegistry | undefined;
  const pendingGenerations = new Set<number>([0]);
  const preparingGenerations = new Set<number>();
  const pendingStyleIds = new Map<number, string[]>();

  const abort = (generation: number) => {
    pendingGenerations.delete(generation);
    pendingStyleIds.delete(generation);
    preparingGenerations.delete(generation);
    registry?.abortRscUpdate(generation);
  };

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

    async run(operation, apply, prepare) {
      const generation = ++nextGeneration;
      pendingGenerations.add(generation);
      registry?.beginRscUpdate(generation);

      let value: Awaited<ReturnType<typeof operation>>;
      try {
        value = await operation(generation);
      } catch (error) {
        abort(generation);
        if (generation < latestResolvedGeneration) return { status: 'superseded' };
        throw error;
      }

      if (generation < latestResolvedGeneration) {
        abort(generation);
        return { status: 'superseded', operationValue: value };
      }

      latestResolvedGeneration = generation;
      for (const preparing of preparingGenerations) {
        if (preparing < generation) registry?.abortRscUpdate(preparing);
      }
      try {
        if (prepare) preparingGenerations.add(generation);
        await prepare?.(value, generation);
      } catch (error) {
        abort(generation);
        if (generation < latestResolvedGeneration) {
          return { status: 'superseded', operationValue: value };
        }
        throw error;
      }
      preparingGenerations.delete(generation);

      if (generation < latestResolvedGeneration) {
        abort(generation);
        return { status: 'superseded', operationValue: value };
      }
      return { status: 'applied', value: apply(value, generation), generation };
    },

    async prepareTree(generation, styleIds) {
      const declared = Array.from(styleIds);
      pendingStyleIds.set(generation, declared);
      if (!registry) {
        if (declared.length === 0) return;
        throw new Error(
          `Development stylesheet registry is unavailable for RSC generation ${generation}.`
        );
      }
      await registry.prepareRscStyles(generation, declared);
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
