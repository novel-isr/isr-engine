import {
  DEV_STYLE_TRANSPORT_GENERATION_PARAM,
  canonicalizeDevStyleId,
  getDevStyleTransportGeneration,
  styleIdsMatch,
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
  const rscDeclarations = new Map<number, string[]>();
  let committedActiveIds: string[] = [];
  let latestCommittedGeneration = -1;

  const canonicalId = (id: string): string => {
    if (!id.trim())
      throw new Error('Cannot publish a development stylesheet without an identifier.');
    return canonicalizeDevStyleId(id, document.baseURI);
  };

  const matchingRecord = (id: string): StyleRecord | undefined => {
    const exact = records.get(id);
    if (exact) return exact;
    return Array.from(records.values()).find(record =>
      styleIdsMatch(record.id, id, document.baseURI)
    );
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
      return linkId !== undefined && styleIdsMatch(linkId, id, document.baseURI);
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

  const isCommitted = (id: string): boolean =>
    committedActiveIds.some(activeId => styleIdsMatch(activeId, id, document.baseURI));

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
    for (const link of matchingLinks(record.id)) {
      const owner = linkGeneration(link);
      if (generation === undefined || owner === undefined || owner <= generation) link.remove();
    }
    record.state = 'released';
    records.delete(record.id);
  };

  const restoreActiveState = (record: StyleRecord) => {
    record.pendingRelease = false;
    record.state = record.node?.isConnected ? 'client-active' : 'ssr-active';
  };

  const sameActiveSet = (left: string[], right: string[]): boolean =>
    left.length === right.length &&
    left.every(id => right.some(other => styleIdsMatch(id, other, document.baseURI)));

  const requiredByPendingGeneration = (id: string, exceptGeneration?: number): boolean =>
    Array.from(rscDeclarations).some(
      ([pending, ids]) =>
        pending !== exceptGeneration &&
        pendingRscGenerations.has(pending) &&
        ids.some(pendingId => styleIdsMatch(pendingId, id, document.baseURI))
    );

  const commitActiveSet = (activeIds: string[], generation?: number) => {
    const hasNewerPendingGeneration =
      generation !== undefined &&
      Array.from(pendingRscGenerations).some(pending => pending > generation);
    const protectedIds =
      generation === undefined
        ? []
        : Array.from(rscDeclarations)
            .filter(([pending]) => pending > generation)
            .flatMap(([, ids]) => ids);

    for (const record of Array.from(records.values())) {
      if (activeIds.some(id => styleIdsMatch(record.id, id, document.baseURI))) {
        restoreActiveState(record);
      } else if (
        protectedIds.some(id => styleIdsMatch(record.id, id, document.baseURI)) ||
        (hasNewerPendingGeneration && !isCommitted(record.id))
      ) {
        restoreActiveState(record);
      } else {
        release(record, generation);
      }
    }
    committedActiveIds = [...activeIds];
  };

  const releaseCommittedTransportLinks = (id: string, generation: number) => {
    for (const link of matchingLinks(id)) {
      const owner = linkGeneration(link);
      if (owner === undefined || owner === generation) link.remove();
    }
  };

  const reconcileCommittedSet = () => {
    for (const id of committedActiveIds) {
      const record = matchingRecord(id);
      if (record?.cssText !== undefined) installManagedNode(record);
    }
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
        for (const link of links) link.remove();
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

    abortRscUpdate(generation) {
      pendingRscGenerations.delete(generation);
      rscDeclarations.delete(generation);
      reconcileCommittedSet();
      for (const link of generationLinks(generation)) {
        const id = stylesheetId(link);
        if (id !== undefined && !isCommitted(id) && !requiredByPendingGeneration(id, generation)) {
          link.remove();
        }
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
      const active = Array.from(new Set(Array.from(activeIds, canonicalId)));
      if (generation === latestCommittedGeneration) {
        if (!sameActiveSet(committedActiveIds, active)) {
          throw new Error(`Conflicting committed stylesheet set for RSC generation ${generation}.`);
        }
        reconcileCommittedSet();
        for (const id of active) releaseCommittedTransportLinks(id, generation);
        return;
      }

      const declared = rscDeclarations.get(generation);
      if (declared && !sameActiveSet(declared, active)) {
        throw new Error(
          `RSC generation ${generation} committed a stylesheet set different from its payload.`
        );
      }
      if (!declared) rscDeclarations.set(generation, active);

      for (const id of active) {
        const record = findOrCreateRecord(id);
        if (record.cssText !== undefined) installManagedNode(record);
      }

      const ready = active.every(id => {
        const record = matchingRecord(id);
        if (record?.node?.isConnected) return true;
        return matchingLinks(id).some(
          link =>
            (generation === 0
              ? linkGeneration(link) === undefined
              : linkGeneration(link) === generation) &&
            !link.dataset.precedence?.startsWith('vite-rsc/client-reference')
        );
      });
      if (!ready) return;

      for (const id of active) {
        if (matchingRecord(id)?.node?.isConnected) {
          releaseCommittedTransportLinks(id, generation);
        }
      }
      commitActiveSet(active, generation);
      latestCommittedGeneration = generation;
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
