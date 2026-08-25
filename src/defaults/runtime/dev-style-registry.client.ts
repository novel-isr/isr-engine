import {
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
  canonicalizeDevStyleId,
  createDevStyleTransportHref,
  getDevStyleTransportGeneration,
} from './dev-style-id';

const RSC_STYLESHEET = 'link[rel="stylesheet"][data-precedence^="vite-rsc/"]';

type DevStyleState = 'ssr-active' | 'client-active' | 'updating' | 'pending-release' | 'released';

interface StyleRecord {
  id: string;
  state: DevStyleState;
  node?: HTMLStyleElement;
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
  prepareRscStyles(generation: number, activeIds: Iterable<string>): Promise<void>;
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
  const committedRscGenerations = new Set<number>();
  const invalidatedTransportGenerations = new Set<number>();
  const preparingRscGenerations = new Set<number>();
  const preparedRscGenerations = new Set<number>();
  const preparationControllers = new Map<number, AbortController>();
  const preparationPromises = new Map<number, Promise<void>>();
  const generationPreloads = new Map<number, Map<string, HTMLLinkElement>>();
  const rscDeclarations = new Map<number, string[]>();
  let committedActiveIds: string[] = [];
  let latestCommittedGeneration = -1;

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

  const generationLinks = (generation: number): HTMLLinkElement[] =>
    Array.from(
      document.querySelectorAll<HTMLLinkElement>(
        `${RSC_STYLESHEET}[href*="${DEV_STYLE_TRANSPORT_GENERATION_PARAM}="]`
      )
    ).filter(link => linkGeneration(link) === generation);

  const isCommitted = (id: string): boolean => committedActiveIds.includes(id);

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
    return node;
  };

  const release = (record: StyleRecord, generation?: number) => {
    record.node?.remove();
    record.node = undefined;
    for (const link of matchingLinks(record.id)) {
      const owner = linkGeneration(link);
      if (generation === undefined || owner === undefined || owner <= generation) link.remove();
    }
    record.pendingRelease = false;
    record.state = 'released';
  };

  const restoreActiveState = (record: StyleRecord) => {
    record.pendingRelease = false;
    record.state = record.node?.isConnected ? 'client-active' : 'ssr-active';
  };

  const sameActiveSet = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every(id => right.includes(id));

  const requiredByPendingGeneration = (id: string, exceptGeneration?: number): boolean =>
    Array.from(rscDeclarations).some(
      ([pending, ids]) =>
        pending !== exceptGeneration && pendingRscGenerations.has(pending) && ids.includes(id)
    );

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
    let selected: HTMLLinkElement | undefined;
    let selectedGeneration = Number.NEGATIVE_INFINITY;
    for (const link of matchingLinks(id)) {
      const owner = linkGeneration(link);
      if (
        !isImporterResource(link) ||
        (exactGeneration && owner !== generation) ||
        (owner !== undefined && (owner > generation || invalidatedTransportGenerations.has(owner)))
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
    if (selected) activateTransportOwner(selected);
    for (const link of matchingLinks(id)) {
      const owner = linkGeneration(link);
      if (
        (owner === undefined ||
          owner <= generation ||
          invalidatedTransportGenerations.has(owner)) &&
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
      convergeCommittedTransport(id, latestCommittedGeneration, !!record?.node?.isConnected);
    }
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

  return {
    publish(id, cssText) {
      const record = findOrCreateRecord(canonicalId(id));
      record.cssText = cssText;
      const links = matchingLinks(record.id);

      if (
        isCommitted(record.id) ||
        (latestCommittedGeneration === -1 && pendingRscGenerations.size === 0 && links.length === 0)
      ) {
        installManagedNode(record);
        if (!isCommitted(record.id)) committedActiveIds.push(record.id);
        convergeCommittedTransport(
          record.id,
          latestCommittedGeneration,
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
      if (generation > latestCommittedGeneration) pendingRscGenerations.add(generation);
    },

    declareRscStyles(generation, activeIds) {
      if (generation < latestCommittedGeneration) return;
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
      this.declareRscStyles(generation, activeIds);
      const existing = preparationPromises.get(generation);
      if (existing) return existing;
      if (generation === 0) {
        preparedRscGenerations.add(generation);
        return Promise.resolve();
      }

      const active = rscDeclarations.get(generation) ?? [];
      const controller = new AbortController();
      const preloads = new Map<string, HTMLLinkElement>();
      generationPreloads.set(generation, preloads);
      preparationControllers.set(generation, controller);
      preparingRscGenerations.add(generation);
      const preparation = Promise.all(
        active.map(id => {
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
      return preparation;
    },

    abortRscUpdate(generation) {
      if (committedRscGenerations.has(generation)) return;
      invalidatedTransportGenerations.add(generation);
      preparationControllers.get(generation)?.abort();
      preparationControllers.delete(generation);
      preparationPromises.delete(generation);
      preparingRscGenerations.delete(generation);
      preparedRscGenerations.delete(generation);
      removeGenerationPreloads(generation);
      pendingRscGenerations.delete(generation);
      rscDeclarations.delete(generation);
      reconcileCommittedSet();
      const abortedLinks = generationLinks(generation);
      const abortedIds = Array.from(
        new Set(abortedLinks.map(stylesheetId).filter((id): id is string => id !== undefined))
      );
      for (const id of abortedIds) {
        const validOwner =
          !!matchingRecord(id)?.node?.isConnected ||
          matchingLinks(id).some(link => {
            const owner = linkGeneration(link);
            return owner === undefined || !invalidatedTransportGenerations.has(owner);
          });
        const stillRequired = isCommitted(id) || requiredByPendingGeneration(id, generation);
        if (validOwner || !stillRequired) {
          for (const link of abortedLinks) {
            if (stylesheetId(link) === id) link.remove();
          }
          continue;
        }
        const invalidOwners = matchingLinks(id).filter(link => {
          const owner = linkGeneration(link);
          return owner !== undefined && invalidatedTransportGenerations.has(owner);
        });
        for (const link of invalidOwners.slice(0, -1)) link.remove();
      }
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
      if (generation < latestCommittedGeneration) return;
      if (
        preparingRscGenerations.has(generation) ||
        (preparationPromises.has(generation) && !preparedRscGenerations.has(generation))
      ) {
        return;
      }
      const active = Array.from(new Set(Array.from(activeIds, canonicalId)));
      if (generation === latestCommittedGeneration) {
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
        if (record?.node?.isConnected) return true;
        return committedTransportOwner(id, generation, exactPreparedOwner) !== undefined;
      });
      if (!ready) return;

      for (const id of active) {
        convergeCommittedTransport(
          id,
          generation,
          !!matchingRecord(id)?.node?.isConnected,
          exactPreparedOwner
        );
      }
      commitActiveSet(active, generation);
      latestCommittedGeneration = generation;
      committedRscGenerations.add(generation);
      removeGenerationPreloads(generation);
      preparationControllers.delete(generation);
      preparationPromises.delete(generation);
      preparingRscGenerations.delete(generation);
      preparedRscGenerations.delete(generation);
      for (const pending of pendingRscGenerations) {
        if (pending <= generation) pendingRscGenerations.delete(pending);
      }
      for (const pending of rscDeclarations.keys()) {
        if (pending <= generation) rscDeclarations.delete(pending);
      }
      options.onRscCommit?.(generation);
    },

    dispose() {
      pendingRscGenerations.clear();
      committedRscGenerations.clear();
      invalidatedTransportGenerations.clear();
      for (const controller of preparationControllers.values()) controller.abort();
      preparationControllers.clear();
      preparationPromises.clear();
      preparingRscGenerations.clear();
      preparedRscGenerations.clear();
      for (const generation of generationPreloads.keys()) removeGenerationPreloads(generation);
      rscDeclarations.clear();
      committedActiveIds = [];
      for (const record of Array.from(records.values())) {
        record.node?.remove();
        record.state = 'released';
      }
      records.clear();
    },
  };
}
