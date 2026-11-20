import { parseLocale, withLocale, type I18nConfig } from '../../runtime/i18n';
import { isPrimaryLinkClick } from './client-navigation-policy';
import { pushLinkNavigation } from './navigation-history.client';

const selector = 'a[data-isr-locale-link]';

function updateLink(link: HTMLAnchorElement): URL | undefined {
  const data = link.dataset.isrLocaleLink;
  if (!data) return undefined;
  try {
    const { locale, ...config } = JSON.parse(data) as I18nConfig & { locale: string };
    const url = new URL(location.href);
    const { pathname } = parseLocale(url.pathname, config);
    url.pathname = withLocale(pathname, locale, config);
    link.href = url.href;
    link.removeAttribute('aria-disabled');
    return url;
  } catch {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    return undefined;
  }
}

/** Enable server-rendered links before hydration and hand navigation to the common router. */
export function installLocaleLinks() {
  let connected = false;
  let pending: string | undefined;

  function navigate(href: string) {
    if (!connected) pending = href;
    else if (location.href !== href) pushLinkNavigation(href);
  }

  function handleLink(event: Event) {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>(selector);
    if (!link) return;
    const url = updateLink(link);
    if (
      url &&
      event instanceof MouseEvent &&
      event.type === 'click' &&
      (!link.target || link.target === '_self') &&
      isPrimaryLinkClick(event)
    ) {
      event.preventDefault();
      navigate(url.href);
    }
  }

  for (const type of ['click', 'auxclick', 'contextmenu', 'focusin']) {
    document.addEventListener(type, handleLink, { capture: true });
  }
  function scan(root: ParentNode) {
    if (root instanceof HTMLAnchorElement && root.matches(selector)) updateLink(root);
    root.querySelectorAll<HTMLAnchorElement>(selector).forEach(updateLink);
  }
  const observer = new MutationObserver(records => {
    for (const { target, type, addedNodes } of records) {
      if (type === 'attributes' && target instanceof HTMLAnchorElement) updateLink(target);
      for (const node of addedNodes) {
        if (node instanceof Element) scan(node);
      }
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-isr-locale-link'],
  });
  scan(document);

  return {
    connect() {
      connected = true;
      queueMicrotask(() => {
        if (!connected || !pending) return;
        const href = pending;
        pending = undefined;
        navigate(href);
      });
    },
    disconnect() {
      connected = false;
    },
  };
}
