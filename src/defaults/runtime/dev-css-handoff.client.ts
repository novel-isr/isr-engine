const CLIENT_REFERENCE_STYLESHEET =
  'link[rel="stylesheet"][data-precedence^="vite-rsc/client-reference"]';
const VITE_DEV_STYLE = 'style[data-vite-dev-id]';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(value: string): string {
  return decode(value).split(/[?#]/, 1)[0]!.replaceAll('\\', '/');
}

function stylesheetPath(link: HTMLLinkElement, document: Document): string {
  try {
    return normalizePath(new URL(link.href, document.baseURI).pathname);
  } catch {
    return normalizePath(link.getAttribute('href') ?? link.href);
  }
}

function hasViteReplacement(link: HTMLLinkElement, document: Document): boolean {
  const href = stylesheetPath(link, document);
  if (!href) return false;

  return Array.from(document.querySelectorAll<HTMLStyleElement>(VITE_DEV_STYLE)).some(style => {
    const id = normalizePath(style.dataset.viteDevId ?? '');
    return id === href || (href.startsWith('/') && id.endsWith(href));
  });
}

/**
 * Transfers stylesheet ownership one resource at a time during Vite development.
 * SSR links remain authoritative until Vite has inserted the matching inline style.
 */
export function handoffDevClientReferenceStyles(
  document: Document = globalThis.document
): () => void {
  const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  let observer: MutationObserver | undefined;

  const removeReadyLinks = () => {
    const links = Array.from(
      document.querySelectorAll<HTMLLinkElement>(CLIENT_REFERENCE_STYLESHEET)
    );
    for (const link of links) {
      if (hasViteReplacement(link, document)) link.remove();
    }
    if (links.length > 0 && links.every(link => !link.isConnected)) observer?.disconnect();
  };

  if (Observer) {
    observer = new Observer(removeReadyLinks);
    observer.observe(document.head, { childList: true });
  }
  removeReadyLinks();

  return () => observer?.disconnect();
}
