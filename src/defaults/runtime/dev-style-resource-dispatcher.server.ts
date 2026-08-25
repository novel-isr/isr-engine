import * as ReactDOM from 'react-dom';

const PINNED_REACT_DOM_VERSION = '19.3.0-canary-bd6ea412-20260824';

interface ReactDomResourceDispatcher {
  S(href: string, precedence: string | undefined, options: { media: string }): void;
}

interface PinnedReactDomModule {
  version: string;
  __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    d: ReactDomResourceDispatcher;
  };
}

function pinnedResourceDispatcher(): ReactDomResourceDispatcher {
  const module = ReactDOM as unknown as Partial<PinnedReactDomModule>;
  const dispatcher = module.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.d;
  if (module.version !== PINNED_REACT_DOM_VERSION || typeof dispatcher?.S !== 'function') {
    throw new Error(
      `[novel-isr] Development CSS transport requires react-dom ${PINNED_REACT_DOM_VERSION} ` +
        'with the pinned stylesheet resource dispatcher shape.'
    );
  }
  return dispatcher;
}

export function assertPinnedDevStyleResourceDispatcher(): void {
  pinnedResourceDispatcher();
}

export function emitDevStylesheetResource(href: string): void {
  pinnedResourceDispatcher().S(href, 'vite-rsc/client-reference', { media: 'not all' });
}
