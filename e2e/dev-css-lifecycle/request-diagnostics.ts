/** A pending navigation does not yet own the old document's subresources. */
export class DocumentRequestTracker {
  private sequence = 0;
  private committed = 0;
  private pending?: { request: object; epoch: number };
  private readonly owners = new WeakMap<object, number>();

  observe(request: object, startsMainDocument: boolean): void {
    if (startsMainDocument) this.pending = { request, epoch: ++this.sequence };
    this.owners.set(request, this.committed);
  }

  commitMainDocument(): void {
    if (!this.pending) return; // Same-document history changes have no new owner.
    this.committed = this.pending.epoch;
    this.pending = undefined;
  }

  navigationFailed(request: object): void {
    if (this.pending?.request === request) this.pending = undefined;
  }

  belongsToEarlierDocument(request: object): boolean {
    const owner = this.owners.get(request);
    return owner !== undefined && owner < (this.pending?.epoch ?? this.committed);
  }
}

export interface BrowserRequestFailure {
  url: string;
  method: string;
  resourceType: string;
  error: string;
  navigationRequest: boolean;
  earlierDocument: boolean;
}

export function isExpectedRscCancellation(failure: BrowserRequestFailure): boolean {
  if (
    failure.error !== 'net::ERR_ABORTED' ||
    failure.method !== 'GET' ||
    failure.resourceType !== 'fetch' ||
    (!failure.navigationRequest && !failure.earlierDocument)
  )
    return false;
  try {
    return new URL(failure.url).pathname.endsWith('_.rsc');
  } catch {
    return false;
  }
}
