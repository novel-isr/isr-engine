/** Tracks ownership across main-document navigation starts, not navigation commits. */
export class DocumentRequestTracker {
  private epoch = 0;
  private readonly owners = new WeakMap<object, number>();

  observe(request: object, startsMainDocument: boolean): void {
    if (startsMainDocument) this.epoch += 1;
    this.owners.set(request, this.epoch);
  }

  belongsToEarlierDocument(request: object): boolean {
    const owner = this.owners.get(request);
    return owner !== undefined && owner < this.epoch;
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
