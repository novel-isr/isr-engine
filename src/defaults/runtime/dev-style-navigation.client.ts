import type { DevStyleRegistry } from './dev-style-registry.client';

export interface DevStyleNavigationLifecycle {
  register(registry: DevStyleRegistry): () => void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  commit(generation: number): void;
}

export function createDevStyleNavigationLifecycle(): DevStyleNavigationLifecycle {
  let nextGeneration = 0;
  let activeGeneration: number | undefined;
  let registry: DevStyleRegistry | undefined;

  return {
    register(nextRegistry) {
      registry = nextRegistry;
      if (activeGeneration !== undefined) nextRegistry.beginRscUpdate(activeGeneration);
      return () => {
        if (registry === nextRegistry) registry = undefined;
      };
    },

    async run(operation) {
      const generation = ++nextGeneration;
      activeGeneration = generation;
      registry?.beginRscUpdate(generation);
      try {
        const result = await operation();
        if (activeGeneration !== generation) {
          const error = new Error('RSC navigation was superseded by a newer generation.');
          error.name = 'AbortError';
          throw error;
        }
        return result;
      } catch (error) {
        if (activeGeneration === generation) {
          registry?.abortRscUpdate(generation);
          activeGeneration = undefined;
        }
        throw error;
      }
    },

    commit(generation) {
      if (activeGeneration === generation) activeGeneration = undefined;
    },
  };
}

const devStyleNavigationLifecycle = createDevStyleNavigationLifecycle();

export const registerDevStyleRegistry = devStyleNavigationLifecycle.register;
export const runWithDevStyleNavigation = devStyleNavigationLifecycle.run;
export const commitDevStyleNavigation = devStyleNavigationLifecycle.commit;
