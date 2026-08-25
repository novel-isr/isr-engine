import {
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
  canonicalizeDevStyleId,
  createDevStyleTransportHref,
  getDevStyleTransportGeneration,
} from './dev-style-id';

const RSC_STYLESHEET = 'link[rel="stylesheet"][data-precedence^="vite-rsc/"]';
const DEV_STYLE_REGISTRY_INSPECT = Symbol.for('novel-isr.dev-style-registry.inspect');
const devStyleRegistries = new WeakMap<Document, DevStyleRegistry>();

type DevStyleState = 'ssr-active' | 'client-active' | 'updating' | 'pending-release' | 'released';

interface StyleRecord {
  id: string;
  state: DevStyleState;
  node?: HTMLStyleElement;
  ownedLink?: HTMLLinkElement;
  cssText?: string;
  pendingRelease: boolean;
}

export interface DevStyleRegistryOptions {
  onRscCommit?(generation: number): void;
}

export interface DevStyleRegistry {
  publish(id: string, cssText: string): void;
  prune(id: string): void;
  beginRscUpdate(generation: number): void;
  declareRscStyles(generation: number, activeIds: Iterable<string>): void;
  prepareRscStyles(generation: number, activeIds?: Iterable<string>): Promise<string[]>;
  abortRscUpdate(generation: number): void;
  beginUpdate(): void;
  commitUpdate(activeIds?: Iterable<string>): void;
  abortUpdate(): void;
  reconcileDocumentStyles(generation: number, activeIds: Iterable<string>): void;
  dispose(): void;
}

export function createDevStyleRegistry(
  document: Document,
  options: DevStyleRegistryOptions = {}
): DevStyleRegistry {
  const records = new Map<string, StyleRecord>();
  const pendingRscGenerations = new Set<number>();
  const invalidatedTransportGenerationRanges: Array<[number, number]> = [];
  const preparingRscGenerations = new Set<number>();
  const preparedRscGenerations = new Set<number>();
  const preparationControllers = new Map<number, AbortController>();
  const preparationPromises = new Map<number, Promise<void>>();
  const generationPreloads = new Map<number, Map<string, HTMLLinkElement>>();
  const rscDeclarations = new Map<number, string[]>();
  const committedTransportNodes = new Map<string, HTMLLinkElement>();
  let committedActiveIds: string[] = [];
  let committedGenerationWatermark = -1;

  const isInvalidatedGeneration = (generation: number): boolean =>
    invalidatedTransportGenerationRanges.some(
      ([start, end]) => generation >= start && generation <= end
    );

  const invalidateGeneration = (generation: number) => {
    let index = 0;
    while (
      index < invalidatedTransportGenerationRanges.length &&
      invalidatedTransportGenerationRanges[index]![1] < generation - 1
    ) {
      index += 1;
    }
    const current = invalidatedTransportGenerationRanges[index];
    if (!current || generation < current[0] - 1) {
      invalidatedTransportGenerationRanges.splice(index, 0, [generation, generation]);
      return;
    }
    current[0] = Math.min(current[0], generation);
    current[1] = Math.max(current[1], generation);
    while (index + 1 < invalidatedTransportGenerationRanges.length) {
      const next = invalidatedTransportGenerationRanges[index + 1]!;
      if (next[0] > current[1] + 1) break;
      current[1] = Math.max(current[1], next[1]);
      invalidatedTransportGenerationRanges.splice(index + 1, 1);
    }
  };

  const clearInvalidatedThrough = (generation: number) => {
    while (
      invalidatedTransportGenerationRanges[0] &&
      invalidatedTransportGenerationRanges[0][1] <= generation
    ) {
      invalidatedTransportGenerationRanges.shift();
    }
    const first = invalidatedTransportGenerationRanges[0];
    if (first && first[0] <= generation) first[0] = generation + 1;
  };

  const canonicalId = (id: string): string => {
    if (!id.trim())
      throw new Error('Cannot publish a development stylesheet without an identifier.');
    return canonicalizeDevStyleId(id, document.baseURI);
  };

  const matchingRecord = (id: string): StyleRecord | undefined => {
    return records.get(id);
  };

  const stylesheetId = (link: HTMLLinkElement): string | undefined => {
    const href = link.getAttribute('href') ?? link.href;
    if (!href) return undefined;
    try {
      return canonicalizeDevStyleId(href, document.baseURI);
    } catch {
      return undefined;
    }
  };

  const findOrCreateRecord = (id: string): StyleRecord => {
    const existing = matchingRecord(id);
    if (existing) return existing;
    const record: StyleRecord = { id, state: 'ssr-active', pendingRelease: false };
    records.set(id, record);
    return record;
  };

  const matchingLinks = (id: string): HTMLLinkElement[] =>
    Array.from(document.querySelectorAll<HTMLLinkElement>(RSC_STYLESHEET)).filter(link => {
      const linkId = stylesheetId(link);
      return linkId === id;
    });

  const linkGeneration = (link: HTMLLinkElement): number | undefined => {
    const href = link.getAttribute('href') ?? link.href;
    return href ? getDevStyleTransportGeneration(href, document.baseURI) : undefined;
  };

  const generationTransportLinks = (): HTMLLinkElement[] =>
    Array.from(
      document.querySelectorAll<HTMLLinkElement>(
        `${RSC_STYLESHEET}[href*="${DEV_STYLE_TRANSPORT_GENERATION_PARAM}="]`
      )
    );

  const generationLinks = (generation: number): HTMLLinkElement[] =>
    generationTransportLinks().filter(link => linkGeneration(link) === generation);

  const bootstrapLinks = new Map<string, HTMLLinkElement>();
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>(RSC_STYLESHEET))) {
    const id = stylesheetId(link);
    if (id === undefined || linkGeneration(link) !== undefined || link.media === 'not all')
      continue;
    bootstrapLinks.set(id, link);
    findOrCreateRecord(id);
    if (!committedActiveIds.includes(id)) committedActiveIds.push(id);
    committedTransportNodes.set(id, link);
  }

  const hasManagedStyle = (record: StyleRecord | undefined): boolean => !!record?.node?.isConnected;

  const hasManagedOwner = (record: StyleRecord | undefined): boolean =>
    hasManagedStyle(record) || !!record?.ownedLink?.isConnected;

  const isCommitted = (id: string): boolean => committedActiveIds.includes(id);

  const committedTransportNode = (id: string): HTMLLinkElement | undefined => {
    const node = committedTransportNodes.get(id);
    if (node?.isConnected && stylesheetId(node) === id) return node;
    committedTransportNodes.delete(id);
    return undefined;
  };

  const installManagedNode = (record: StyleRecord): HTMLStyleElement => {
    const node = record.node?.isConnected ? record.node : document.createElement('style');
    if (!node.isConnected) {
      node.setAttribute('data-novel-isr-dev-style', record.id);
      document.head.appendChild(node);
      record.node = node;
    }
    if (record.cssText !== undefined) node.textContent = record.cssText;
    record.pendingRelease = false;
    record.state = 'client-active';
    record.ownedLink?.remove();
    record.ownedLink = undefined;
    const transport = committedTransportNode(record.id);
    committedTransportNodes.delete(record.id);
    transport?.remove();
    return node;
  };

  const release = (record: StyleRecord, generation?: number) => {
    record.node?.remove();
    record.node = undefined;
    record.ownedLink?.remove();
    record.ownedLink = undefined;
    committedTransportNodes.delete(record.id);
    for (const link of matchingLinks(record.id)) {
      const owner = linkGeneration(link);
      if (generation === undefined || owner === undefined || owner <= generation) link.remove();
    }
    record.pendingRelease = false;
    record.state = 'released';
  };

  const restoreActiveState = (record: StyleRecord) => {
    record.pendingRelease = false;
    record.state = hasManagedOwner(record) ? 'client-active' : 'ssr-active';
  };

  const sameActiveSet = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every(id => right.includes(id));

  const commitActiveSet = (activeIds: string[], generation?: number) => {
    for (const record of Array.from(records.values())) {
      if (activeIds.includes(record.id)) {
        restoreActiveState(record);
      } else {
        release(record, generation);
      }
    }
    committedActiveIds = [...activeIds];
  };

  const isImporterResource = (link: HTMLLinkElement): boolean =>
    !!link.dataset.precedence?.startsWith('vite-rsc/importer-resources');

  const committedTransportOwner = (
    id: string,
    generation: number,
    exactGeneration = false
  ): HTMLLinkElement | undefined => {
    const current = committedTransportNode(id);
    let selected: HTMLLinkElement | undefined;
    let selectedGeneration = Number.NEGATIVE_INFINITY;
    for (const link of matchingLinks(id)) {
      const owner = linkGeneration(link);
      const isCurrent = link === current;
      if (
        !isImporterResource(link) ||
        (exactGeneration && owner !== generation && !(generation === 0 && owner === undefined)) ||
        (!isCurrent && owner === undefined && committedGenerationWatermark > 0) ||
        (!isCurrent &&
          owner !== undefined &&
          (owner < committedGenerationWatermark ||
            owner > generation ||
            isInvalidatedGeneration(owner)))
      ) {
        continue;
      }
      const rank = owner ?? Number.NEGATIVE_INFINITY;
      if (rank >= selectedGeneration) {
        selected = link;
        selectedGeneration = rank;
      }
    }
    return selected;
  };

  const activateTransportOwner = (link: HTMLLinkElement) => {
    if (link.media === 'not all') link.removeAttribute('media');
  };

  const convergeCommittedTransport = (
    id: string,
    generation: number,
    managed: boolean,
    exactGeneration = false
  ): boolean => {
    const selected = managed ? undefined : committedTransportOwner(id, generation, exactGeneration);
    if (!managed && !selected) return false;
    if (selected) {
      activateTransportOwner(selected);
      committedTransportNodes.set(id, selected);
    } else {
      committedTransportNodes.delete(id);
    }
    for (const link of matchingLinks(id)) {
      const owner = linkGeneration(link);
      if (
        (owner === undefined || owner <= generation || isInvalidatedGeneration(owner)) &&
        link !== selected
      ) {
        link.remove();
      }
    }
    return true;
  };

  const reconcileCommittedSet = () => {
    for (const id of committedActiveIds) {
      const record = matchingRecord(id);
      if (record?.cssText !== undefined) installManagedNode(record);
      convergeCommittedTransport(id, committedGenerationWatermark, hasManagedStyle(record));
    }
  };

  const adoptBootstrapOwner = (id: string): Promise<void> => {
    const record = findOrCreateRecord(id);
    if (hasManagedOwner(record)) return Promise.resolve();
    const bootstrap = bootstrapLinks.get(id);
    if (!bootstrap?.isConnected) {
      return Promise.reject(
        new Error(`Bootstrap stylesheet ${id} was removed before engine ownership was established.`)
      );
    }

    const owned = bootstrap.cloneNode(false) as HTMLLinkElement;
    owned.removeAttribute('data-rsc-css-href');
    owned.dataset.novelIsrDevStyleLink = id;

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        owned.removeEventListener('load', onLoad);
        owned.removeEventListener('error', onError);
      };
      const onLoad = () => {
        cleanup();
        if (record.node?.isConnected) {
          owned.remove();
        } else {
          record.ownedLink = owned;
          record.state = 'client-active';
        }
        bootstrap.remove();
        bootstrapLinks.delete(id);
        committedTransportNodes.delete(id);
        resolve();
      };
      const onError = () => {
        cleanup();
        owned.remove();
        reject(new Error(`Failed to adopt bootstrap stylesheet ${id}.`));
      };
      owned.addEventListener('load', onLoad, { once: true });
      owned.addEventListener('error', onError, { once: true });
      document.head.appendChild(owned);
      if (owned.sheet) onLoad();
    });
  };

  const transportHref = (id: string, generation: number): string => {
    return createDevStyleTransportHref(id, generation, document.baseURI);
  };

  const prepareTransport = (generation: number, id: string, signal: AbortSignal): Promise<void> => {
    const href = transportHref(id, generation);
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'style';
    link.href = href;
    link.dataset.novelIsrDevStylePreload = id;
    generationPreloads.get(generation)?.set(id, link);

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        link.removeEventListener('load', onLoad);
        link.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to preload development stylesheet ${id}.`));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`Development stylesheet generation ${generation} was aborted.`));
      };
      link.addEventListener('load', onLoad, { once: true });
      link.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      document.head.appendChild(link);
      if (signal.aborted) onAbort();
    });
  };

  const removeGenerationPreloads = (generation: number) => {
    const preloads = generationPreloads.get(generation);
    if (!preloads) return;
    for (const link of preloads.values()) link.remove();
    generationPreloads.delete(generation);
  };

  const clearGenerationState = (generation: number, abortPreparation: boolean) => {
    const controller = preparationControllers.get(generation);
    if (abortPreparation) controller?.abort();
    preparationControllers.delete(generation);
    preparationPromises.delete(generation);
    preparingRscGenerations.delete(generation);
    preparedRscGenerations.delete(generation);
    removeGenerationPreloads(generation);
    pendingRscGenerations.delete(generation);
    rscDeclarations.delete(generation);
  };

  const removeGenerationTransport = (generation: number) => {
    for (const link of generationLinks(generation)) {
      const id = stylesheetId(link);
      if (id !== undefined && committedTransportNode(id) === link) continue;
      link.remove();
    }
  };

  const clearObsoleteGeneration = (generation: number) => {
    clearGenerationState(generation, true);
    removeGenerationTransport(generation);
  };

  const reconcileCommittedGenerationTouch = (generation: number) => {
    clearGenerationState(generation, false);
    reconcileCommittedSet();
    for (const link of generationLinks(generation)) {
      const id = stylesheetId(link);
      if (id === undefined || !committedActiveIds.includes(id)) link.remove();
    }
  };

  const invalidateUncommittedGeneration = (generation: number) => {
    if (generation < committedGenerationWatermark) {
      clearObsoleteGeneration(generation);
      return;
    }
    if (generation === committedGenerationWatermark) {
      reconcileCommittedGenerationTouch(generation);
      return;
    }
    invalidateGeneration(generation);
    clearObsoleteGeneration(generation);
    reconcileCommittedSet();
  };

  const finalizeDroppedGenerations = (committingGeneration: number) => {
    const candidates = new Set<number>([
      ...pendingRscGenerations,
      ...preparingRscGenerations,
      ...preparedRscGenerations,
      ...preparationControllers.keys(),
      ...preparationPromises.keys(),
      ...generationPreloads.keys(),
      ...rscDeclarations.keys(),
    ]);
    const dropped = Array.from(candidates)
      .filter(
        generation => generation > committedGenerationWatermark && generation < committingGeneration
      )
      .sort((left, right) => left - right);
    if (dropped.length === 0) return;
    for (const generation of dropped) {
      invalidateGeneration(generation);
      clearObsoleteGeneration(generation);
    }
    reconcileCommittedSet();
  };

  const clearCommittedGenerationState = (generation: number) => {
    const candidates = new Set<number>([
      ...pendingRscGenerations,
      ...preparingRscGenerations,
      ...preparedRscGenerations,
      ...preparationControllers.keys(),
      ...preparationPromises.keys(),
      ...generationPreloads.keys(),
      ...rscDeclarations.keys(),
    ]);
    for (const candidate of candidates) {
      if (candidate <= generation) clearGenerationState(candidate, candidate < generation);
    }
    for (const link of generationTransportLinks()) {
      const owner = linkGeneration(link);
      const id = stylesheetId(link);
      if (
        owner !== undefined &&
        owner < generation &&
        isInvalidatedGeneration(owner) &&
        (id === undefined || committedTransportNode(id) !== link)
      ) {
        link.remove();
      }
    }
    clearInvalidatedThrough(generation);
  };

  const sorted = (values: Iterable<number>): number[] => Array.from(values).sort((a, b) => a - b);

  const inspectGenerationState = () => ({
    committedWatermark: committedGenerationWatermark,
    controllers: sorted(preparationControllers.keys()),
    declarations: sorted(rscDeclarations.keys()),
    invalidatedRanges: invalidatedTransportGenerationRanges.map(([start, end]) => [start, end]),
    pending: sorted(pendingRscGenerations),
    preloads: sorted(generationPreloads.keys()),
    prepared: sorted(preparedRscGenerations),
    preparing: sorted(preparingRscGenerations),
    promises: sorted(preparationPromises.keys()),
  });

  const registry: DevStyleRegistry = {
    publish(id, cssText) {
      const record = findOrCreateRecord(canonicalId(id));
      record.cssText = cssText;
      const links = matchingLinks(record.id);

      if (
        isCommitted(record.id) ||
        (committedGenerationWatermark === -1 &&
          pendingRscGenerations.size === 0 &&
          links.length === 0)
      ) {
        installManagedNode(record);
        if (!isCommitted(record.id)) committedActiveIds.push(record.id);
        convergeCommittedTransport(
          record.id,
          committedGenerationWatermark,
          !!record.node?.isConnected
        );
      }
    },

    prune(id) {
      const record = matchingRecord(canonicalId(id));
      if (!record) return;
      record.pendingRelease = true;
      record.state = 'pending-release';
    },

    beginRscUpdate(generation) {
      if (generation <= committedGenerationWatermark || isInvalidatedGeneration(generation)) {
        if (generation < committedGenerationWatermark || isInvalidatedGeneration(generation)) {
          clearObsoleteGeneration(generation);
        } else {
          reconcileCommittedGenerationTouch(generation);
        }
        return;
      }
      pendingRscGenerations.add(generation);
    },

    declareRscStyles(generation, activeIds) {
      if (generation <= committedGenerationWatermark || isInvalidatedGeneration(generation)) {
        if (generation < committedGenerationWatermark) clearObsoleteGeneration(generation);
        else if (isInvalidatedGeneration(generation)) {
          clearObsoleteGeneration(generation);
        } else {
          reconcileCommittedGenerationTouch(generation);
        }
        return;
      }
      const active = Array.from(new Set(Array.from(activeIds, canonicalId)));
      const existing = rscDeclarations.get(generation);
      if (existing && !sameActiveSet(existing, active)) {
        throw new Error(
          `Conflicting development stylesheet declarations for RSC generation ${generation}.`
        );
      }
      for (const id of active) findOrCreateRecord(id);
      rscDeclarations.set(generation, active);
    },

    prepareRscStyles(generation, activeIds) {
      if (generation <= committedGenerationWatermark || isInvalidatedGeneration(generation)) {
        if (generation < committedGenerationWatermark || isInvalidatedGeneration(generation)) {
          clearObsoleteGeneration(generation);
        } else {
          reconcileCommittedGenerationTouch(generation);
        }
        return Promise.resolve([...committedActiveIds]);
      }
      const active =
        activeIds === undefined
          ? generation === 0
            ? [...committedActiveIds]
            : Array.from(
                new Set(
                  generationLinks(generation).flatMap(link => {
                    const id = stylesheetId(link);
                    return id === undefined ? [] : [id];
                  })
                )
              )
          : Array.from(activeIds);
      this.declareRscStyles(generation, active);
      const existing = preparationPromises.get(generation);
      if (existing) return existing.then(() => [...(rscDeclarations.get(generation) ?? active)]);
      if (generation === 0) {
        const preparation =
          activeIds === undefined
            ? Promise.all(active.map(adoptBootstrapOwner)).then(() => undefined)
            : Promise.resolve();
        return preparation.then(() => {
          preparedRscGenerations.add(generation);
          return [...active];
        });
      }

      const declared = rscDeclarations.get(generation) ?? [];
      const controller = new AbortController();
      const preloads = new Map<string, HTMLLinkElement>();
      generationPreloads.set(generation, preloads);
      preparationControllers.set(generation, controller);
      preparingRscGenerations.add(generation);
      const preparation = Promise.all(
        declared.map(id => {
          const record = matchingRecord(id);
          return record?.cssText === undefined
            ? prepareTransport(generation, id, controller.signal)
            : Promise.resolve();
        })
      ).then(() => {
        if (controller.signal.aborted) {
          throw new Error(`Development stylesheet generation ${generation} was aborted.`);
        }
        preparingRscGenerations.delete(generation);
        preparedRscGenerations.add(generation);
      });
      preparation.catch(() => {
        preparingRscGenerations.delete(generation);
      });
      preparationPromises.set(generation, preparation);
      return preparation.then(() => [...declared]);
    },

    abortRscUpdate(generation) {
      invalidateUncommittedGeneration(generation);
    },

    beginUpdate() {
      for (const record of records.values()) {
        if (!record.pendingRelease) record.state = 'updating';
      }
    },

    commitUpdate(activeIds) {
      if (activeIds === undefined) {
        for (const record of records.values()) {
          if (record.pendingRelease) restoreActiveState(record);
        }
        return;
      }
      commitActiveSet(Array.from(activeIds, canonicalId));
    },

    abortUpdate() {
      for (const record of records.values()) {
        if (record.pendingRelease || record.state === 'updating') restoreActiveState(record);
      }
    },

    reconcileDocumentStyles(generation, activeIds) {
      if (generation < committedGenerationWatermark || isInvalidatedGeneration(generation)) {
        clearObsoleteGeneration(generation);
        return;
      }
      if (generation === committedGenerationWatermark) {
        reconcileCommittedGenerationTouch(generation);
      }
      if (
        preparingRscGenerations.has(generation) ||
        (preparationPromises.has(generation) && !preparedRscGenerations.has(generation))
      ) {
        return;
      }
      const active = Array.from(new Set(Array.from(activeIds, canonicalId)));
      if (generation === committedGenerationWatermark) {
        if (!sameActiveSet(committedActiveIds, active)) {
          throw new Error(`Conflicting committed stylesheet set for RSC generation ${generation}.`);
        }
        reconcileCommittedSet();
        return;
      }

      const declared = rscDeclarations.get(generation);
      if (declared && !sameActiveSet(declared, active)) {
        throw new Error(
          `RSC generation ${generation} committed a stylesheet set different from its payload.`
        );
      }
      if (!declared) rscDeclarations.set(generation, active);
      const exactPreparedOwner = preparedRscGenerations.has(generation);

      for (const id of active) {
        const record = findOrCreateRecord(id);
        if (record.cssText !== undefined) installManagedNode(record);
      }

      const ready = active.every(id => {
        const record = matchingRecord(id);
        if (hasManagedOwner(record)) return true;
        return committedTransportOwner(id, generation, exactPreparedOwner) !== undefined;
      });
      if (!ready) return;

      finalizeDroppedGenerations(generation);

      for (const id of active) {
        convergeCommittedTransport(
          id,
          generation,
          hasManagedStyle(matchingRecord(id)),
          exactPreparedOwner
        );
      }
      commitActiveSet(active, generation);
      committedGenerationWatermark = generation;
      clearCommittedGenerationState(generation);
      options.onRscCommit?.(generation);
    },

    dispose() {
      pendingRscGenerations.clear();
      invalidatedTransportGenerationRanges.length = 0;
      for (const controller of preparationControllers.values()) controller.abort();
      preparationControllers.clear();
      preparationPromises.clear();
      preparingRscGenerations.clear();
      preparedRscGenerations.clear();
      for (const generation of generationPreloads.keys()) removeGenerationPreloads(generation);
      rscDeclarations.clear();
      committedTransportNodes.clear();
      committedActiveIds = [];
      for (const record of Array.from(records.values())) {
        record.node?.remove();
        record.ownedLink?.remove();
        record.state = 'released';
      }
      records.clear();
    },
  };
  Object.defineProperty(registry, DEV_STYLE_REGISTRY_INSPECT, {
    value: inspectGenerationState,
  });
  return registry;
}

export function getOrCreateDevStyleRegistry(
  document: Document,
  options: DevStyleRegistryOptions = {}
): DevStyleRegistry {
  const existing = devStyleRegistries.get(document);
  if (existing) return existing;
  const registry = createDevStyleRegistry(document, options);
  devStyleRegistries.set(document, registry);
  return registry;
}
