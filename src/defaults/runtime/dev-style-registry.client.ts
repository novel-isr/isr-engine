import { canonicalizeDevStyleId, styleIdsMatch } from './dev-style-id';

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
  abortRscUpdate(generation: number): void;
  beginUpdate(): void;
  commitUpdate(activeIds?: Iterable<string>): void;
  abortUpdate(): void;
  reconcileDocumentStyles(generation: number): void;
  dispose(): void;
}

export function createDevStyleRegistry(
  document: Document,
  options: DevStyleRegistryOptions = {}
): DevStyleRegistry {
  const records = new Map<string, StyleRecord>();
  const pendingRscGenerations = new Set<number>();
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

  const release = (record: StyleRecord) => {
    record.node?.remove();
    for (const link of matchingLinks(record.id)) link.remove();
    record.state = 'released';
    records.delete(record.id);
  };

  const restoreActiveState = (record: StyleRecord) => {
    record.pendingRelease = false;
    record.state = record.node?.isConnected ? 'client-active' : 'ssr-active';
  };

  const commitActiveSet = (activeIds: string[]) => {
    for (const record of Array.from(records.values())) {
      if (activeIds.some(id => styleIdsMatch(record.id, id, document.baseURI))) {
        restoreActiveState(record);
      } else {
        release(record);
      }
    }
    committedActiveIds = [...activeIds];
  };

  const reconcileCommittedSet = () => {
    for (const id of committedActiveIds) {
      const record = matchingRecord(id);
      if (record?.cssText !== undefined) installManagedNode(record);
      if (record?.node?.isConnected) {
        for (const link of matchingLinks(id)) link.remove();
      }
    }
  };

  return {
    publish(id, cssText) {
      const record = findOrCreateRecord(canonicalId(id));
      record.cssText = cssText;
      const links = matchingLinks(record.id);

      if (isCommitted(record.id) || (pendingRscGenerations.size === 0 && links.length === 0)) {
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

    abortRscUpdate(generation) {
      pendingRscGenerations.delete(generation);
      reconcileCommittedSet();
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

    reconcileDocumentStyles(generation) {
      if (generation < latestCommittedGeneration) return;
      if (generation === latestCommittedGeneration) {
        reconcileCommittedSet();
        return;
      }

      const links = Array.from(document.querySelectorAll<HTMLLinkElement>(RSC_STYLESHEET));
      const activeIds = Array.from(
        new Set(links.map(stylesheetId).filter((id): id is string => id !== undefined))
      );

      for (const id of activeIds) {
        const record = findOrCreateRecord(id);
        if (record.cssText !== undefined) installManagedNode(record);
      }

      const ready = activeIds.every(id => {
        const record = matchingRecord(id);
        if (record?.node?.isConnected) return true;
        return matchingLinks(id).some(
          link => !link.dataset.precedence?.startsWith('vite-rsc/client-reference')
        );
      });
      if (!ready) return;

      for (const id of activeIds) {
        if (matchingRecord(id)?.node?.isConnected) {
          for (const link of matchingLinks(id)) link.remove();
        }
      }
      commitActiveSet(activeIds);
      latestCommittedGeneration = generation;
      for (const pending of pendingRscGenerations) {
        if (pending <= generation) pendingRscGenerations.delete(pending);
      }
      options.onRscCommit?.(generation);
    },

    dispose() {
      pendingRscGenerations.clear();
      committedActiveIds = [];
      for (const record of Array.from(records.values())) {
        record.node?.remove();
        record.state = 'released';
      }
      records.clear();
    },
  };
}
