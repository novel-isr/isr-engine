import { canonicalizeDevStyleId, styleIdsMatch } from './dev-style-id';

const SSR_STYLESHEET = 'link[rel="stylesheet"][data-precedence^="vite-rsc/"]';

type DevStyleState = 'ssr-active' | 'client-active' | 'updating' | 'pending-release' | 'released';

interface StyleRecord {
  id: string;
  state: DevStyleState;
  node?: HTMLStyleElement;
  cssText?: string;
  pendingRelease: boolean;
}

interface RscStyleTransaction {
  generation: number;
  declaredActiveIds: Set<string>;
  reconciledActiveIds?: string[];
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
  reconcileDocumentStyles(): void;
  dispose(): void;
}

export function createDevStyleRegistry(
  document: Document,
  options: DevStyleRegistryOptions = {}
): DevStyleRegistry {
  const records = new Map<string, StyleRecord>();
  let committedActiveIds: string[] = [];
  let rscTransaction: RscStyleTransaction | undefined = {
    generation: 0,
    declaredActiveIds: new Set(),
  };

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

    const record: StyleRecord = {
      id,
      state: 'ssr-active',
      pendingRelease: false,
    };
    records.set(id, record);
    return record;
  };

  const matchingLinks = (id: string): HTMLLinkElement[] =>
    Array.from(document.querySelectorAll<HTMLLinkElement>(SSR_STYLESHEET)).filter(link => {
      const linkId = stylesheetId(link);
      return linkId !== undefined && styleIdsMatch(linkId, id, document.baseURI);
    });

  const installManagedNode = (record: StyleRecord): HTMLStyleElement => {
    if (record.node?.isConnected) return record.node;

    const node = document.createElement('style');
    node.setAttribute('data-novel-isr-dev-style', record.id);
    document.head.appendChild(node);
    record.node = node;
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

  const rollbackRscTransaction = (transaction: RscStyleTransaction) => {
    if (rscTransaction !== transaction) return;
    rscTransaction = undefined;
    commitActiveSet(committedActiveIds);
  };

  const commitRscTransactionWhenReady = (): boolean => {
    const transaction = rscTransaction;
    const activeIds = transaction?.reconciledActiveIds;
    if (transaction === undefined || activeIds === undefined) return false;
    if (
      !activeIds.every(id => {
        const record = matchingRecord(id);
        if (record?.node?.isConnected === true) return true;
        return matchingLinks(id).some(
          link => !link.dataset.precedence?.startsWith('vite-rsc/client-reference')
        );
      })
    ) {
      return false;
    }

    for (const id of activeIds) {
      if (matchingRecord(id)?.node?.isConnected === true) {
        for (const link of matchingLinks(id)) link.remove();
      }
    }
    rscTransaction = undefined;
    commitActiveSet(activeIds);
    options.onRscCommit?.(transaction.generation);
    return true;
  };

  const reconcileCommittedSet = () => {
    for (const id of committedActiveIds) {
      if (matchingRecord(id)?.node?.isConnected === true) {
        for (const link of matchingLinks(id)) link.remove();
      }
    }
    commitActiveSet(committedActiveIds);
  };

  return {
    publish(id, cssText) {
      const record = findOrCreateRecord(canonicalId(id));
      const node = installManagedNode(record);
      node.textContent = cssText;
      record.cssText = cssText;
      restoreActiveState(record);

      if (node.isConnected && node.textContent === cssText) {
        for (const link of matchingLinks(record.id)) {
          const linkId = stylesheetId(link);
          if (linkId) rscTransaction?.declaredActiveIds.add(linkId);
          link.remove();
        }
      }
      commitRscTransactionWhenReady();
    },

    prune(id) {
      const record = matchingRecord(canonicalId(id));
      if (!record) return;
      record.pendingRelease = true;
      record.state = 'pending-release';
    },

    beginRscUpdate(generation) {
      if (rscTransaction?.generation === generation) return;
      if (rscTransaction !== undefined) rollbackRscTransaction(rscTransaction);
      rscTransaction = {
        generation,
        declaredActiveIds: new Set(),
      };
    },

    abortRscUpdate(generation) {
      if (rscTransaction?.generation === generation) rollbackRscTransaction(rscTransaction);
    },

    beginUpdate() {
      for (const record of records.values()) {
        if (!record.pendingRelease) record.state = 'updating';
      }
    },

    commitUpdate(activeIds) {
      if (activeIds === undefined) {
        if (commitRscTransactionWhenReady()) return;
        for (const record of records.values()) {
          if (record.pendingRelease) restoreActiveState(record);
        }
        return;
      }

      const active = Array.from(activeIds, canonicalId);
      rscTransaction = undefined;
      commitActiveSet(active);
    },

    abortUpdate() {
      for (const record of records.values()) {
        if (record.pendingRelease || record.state === 'updating') restoreActiveState(record);
      }
    },

    reconcileDocumentStyles() {
      const transaction = rscTransaction;
      if (transaction === undefined) {
        reconcileCommittedSet();
        return;
      }

      for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>(SSR_STYLESHEET))) {
        const id = stylesheetId(link);
        if (id) {
          transaction.declaredActiveIds.add(id);
          findOrCreateRecord(id);
        }
      }
      transaction.reconciledActiveIds = Array.from(transaction.declaredActiveIds);
      commitRscTransactionWhenReady();
    },

    dispose() {
      rscTransaction = undefined;
      committedActiveIds = [];
      for (const record of Array.from(records.values())) {
        record.node?.remove();
        record.state = 'released';
      }
      records.clear();
    },
  };
}
