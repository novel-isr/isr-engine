/// <reference types="vite/client" />

interface InspectorState {
  mode: string;
  modeSource: string;
  strategy: string;
  cache: string;
  fallback: string;
  i18nSource: string;
  language: string;
  status: number | null;
  url: string;
}

const INSPECTOR_ID = 'novel-isr-render-inspector';
let deferredInstallScheduled = false;
let watchdogStarted = false;
let watchdogInstallScheduled = false;

type InspectorMode = (typeof MODE_LINKS)[number]['key'] | 'unknown';

interface InspectorViewModel {
  resolvedMode: InspectorMode;
  modeCode: string;
  modeLabel: string;
  modeSource: string;
  strategy: string;
  cacheTone: string;
  cacheLabel: string;
  fallbackActive: boolean;
}

const MODE_LINKS = [
  {
    key: 'isr',
    label: 'ISR 缓存',
    desc: '当前 URL 走缓存渲染；命中后回放，过期后按 SWR 重生。',
  },
  {
    key: 'ssr',
    label: 'SSR 实时',
    desc: '当前 URL 每次请求实时渲染，按设计绕过页面缓存。',
  },
  {
    key: 'ssg',
    label: 'SSG 策略',
    desc: '开发态验证 SSG 缓存策略；生产静态产物来自 build 预生成。',
  },
  {
    key: 'csr',
    label: 'CSR 降级',
    desc: '强制进入客户端自救壳，验证 fallback 体验。',
  },
] as const;

export function installDevRenderInspector(): void {
  if (!isDevRenderInspectorRuntimeEnabled(import.meta.env, import.meta.hot)) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(INSPECTOR_ID)) return;
  if (shouldDeferDevRenderInspectorMount(document)) {
    scheduleDeferredInstall();
    return;
  }
  startInspectorWatchdog();

  const host = document.createElement('div');
  host.id = INSPECTOR_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  let expanded = false;
  let state: InspectorState | null = null;

  const render = () => {
    const view = resolveDevRenderInspectorView({
      state,
      href: window.location.href,
    });

    shadow.innerHTML = `
      <style>${STYLE}</style>
      <aside class="inspector" aria-label="Novel ISR 开发模式渲染检查器">
        <button type="button" class="summary" data-action="toggle" aria-expanded="${expanded}">
          ${summaryPill('Mode', view.modeCode, 'mode', view.resolvedMode)}
          ${summaryPill('Strategy', view.strategy, 'strategy')}
          ${summaryPill('Cache', view.cacheLabel, 'cache', view.cacheTone)}
        </button>
        ${
          expanded
            ? `
              <div class="panel">
                <div class="panel-head">
                  <div>
                    <p class="eyebrow">Novel ISR Inspector</p>
                    <strong>Render mode · ${escapeHtml(view.modeCode)}</strong>
                    <span class="mode-desc">${escapeHtml(view.modeLabel)}</span>
                  </div>
                  <span class="status">${escapeHtml(String(state?.status ?? 'ERR'))}</span>
                </div>
                <dl class="details">
                  ${detailRow('Page', state?.url ?? '-')}
                  ${detailRow('Mode', `${view.modeCode} · ${view.modeLabel}`)}
                  ${detailRow('Mode Source', view.modeSource)}
                  ${detailRow('Strategy', view.strategy)}
                  ${detailRow('Cache', view.cacheLabel)}
                  ${detailRow('I18n', `${state?.language ?? '-'} · ${state?.i18nSource ?? '-'}`)}
                  ${detailRow('Fallback', view.fallbackActive ? 'CSR shell' : 'false', view.fallbackActive)}
                </dl>
                <div class="mode-grid" aria-label="渲染模式测试入口">
                  ${MODE_LINKS.map(
                    item => `
                      <button
                        type="button"
                        class="mode-link"
                        data-mode-switch="${item.key}"
                        data-active="${view.resolvedMode === item.key ? 'true' : 'false'}"
                      >
                        <span>${escapeHtml(item.label)}</span>
                        <small>${escapeHtml(item.desc)}</small>
                      </button>
                    `
                  ).join('')}
                </div>
                <p class="help">
                  切换只改当前 URL 调试参数；CSR 是 fallback 验证，不是用户级缓存模式。
                </p>
              </div>
            `
            : ''
        }
      </aside>
    `;
  };

  shadow.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>('[data-action]');
    if (action?.dataset.action === 'toggle') {
      expanded = !expanded;
      render();
      return;
    }

    const modeButton = target.closest<HTMLElement>('[data-mode-switch]');
    if (modeButton?.dataset.modeSwitch) {
      switchMode(modeButton.dataset.modeSwitch);
    }
  });

  render();
  void inspectCurrentPage().then(next => {
    state = next;
    render();
  });
}

export function isDevRenderInspectorRuntimeEnabled(
  env: { DEV?: boolean } | undefined,
  hot: unknown
): boolean {
  return env?.DEV === true || Boolean(hot);
}

interface InspectorDocumentTarget {
  body: HTMLElement | null;
}

interface InspectorMountTarget extends InspectorDocumentTarget {
  getElementById: (elementId: string) => HTMLElement | null;
}

export function shouldDeferDevRenderInspectorMount(doc: InspectorDocumentTarget): boolean {
  return !doc.body;
}

export function shouldMountDevRenderInspector(doc: InspectorMountTarget): boolean {
  return Boolean(doc.body) && !doc.getElementById(INSPECTOR_ID);
}

function scheduleDeferredInstall(): void {
  if (deferredInstallScheduled) return;
  deferredInstallScheduled = true;
  const retry = () => {
    deferredInstallScheduled = false;
    installDevRenderInspector();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', retry, { once: true });
    return;
  }
  window.setTimeout(retry, 0);
}

function startInspectorWatchdog(): void {
  if (watchdogStarted) return;
  if (typeof MutationObserver === 'undefined') return;
  if (!document.documentElement) return;
  watchdogStarted = true;

  const scheduleEnsureMounted = () => {
    if (watchdogInstallScheduled) return;
    watchdogInstallScheduled = true;
    window.setTimeout(() => {
      watchdogInstallScheduled = false;
      if (shouldMountDevRenderInspector(document)) {
        installDevRenderInspector();
      }
    }, 0);
  };

  const observer = new MutationObserver(() => {
    if (!shouldMountDevRenderInspector(document)) return;
    scheduleEnsureMounted();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

async function inspectCurrentPage(): Promise<InspectorState> {
  const url = new URL(window.location.href);
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'text/html',
        'X-Novel-Isr-Inspector': '1',
      },
    });
    await response.text().catch(() => undefined);
    return {
      mode: readHeader(response.headers, 'x-resolved-mode'),
      strategy: readHeader(response.headers, 'x-render-strategy'),
      cache: readHeader(response.headers, 'x-cache-status'),
      fallback: readHeader(response.headers, 'x-fallback-used'),
      i18nSource: readHeader(response.headers, 'x-i18n-source'),
      language: readHeader(response.headers, 'content-language'),
      modeSource: readHeader(response.headers, 'x-mode-source'),
      status: response.status,
      url: `${url.pathname}${url.search}`,
    };
  } catch {
    return {
      mode: 'unknown',
      strategy: 'unknown',
      cache: 'unknown',
      fallback: 'unknown',
      i18nSource: 'unknown',
      language: 'unknown',
      modeSource: 'unknown',
      status: null,
      url: `${url.pathname}${url.search}`,
    };
  }
}

export function resolveDevRenderInspectorView({
  state,
  href,
}: {
  state: Pick<InspectorState, 'mode' | 'modeSource' | 'cache' | 'fallback' | 'strategy'> | null;
  href: string;
}): InspectorViewModel {
  const url = new URL(href);
  const fallbackActive = state?.fallback === 'true' || url.searchParams.has('__csr-shell');
  const headerMode = normalizeMode(state?.mode);
  const inferredMode = inferModeFromUrl(url);
  const resolvedMode = fallbackActive
    ? 'csr'
    : headerMode === 'unknown'
      ? inferredMode
      : headerMode;
  const cacheState = normalizeToken(state?.cache, state ? 'unknown' : 'loading');
  const cacheTone = fallbackActive ? 'bypass' : cacheState;
  const modeMeta = MODE_LINKS.find(item => item.key === resolvedMode);

  return {
    resolvedMode,
    modeCode: resolvedMode === 'unknown' ? 'UNKNOWN' : resolvedMode.toUpperCase(),
    modeLabel: modeMeta?.label ?? '未知模式',
    modeSource:
      normalizeToken(state?.modeSource, '') ||
      (inferredMode !== 'unknown' ? 'url-inferred' : 'pending'),
    strategy: normalizeToken(state?.strategy, state ? 'unknown' : 'loading'),
    cacheTone,
    cacheLabel: state ? displayCache(resolvedMode, cacheState) : '检测中',
    fallbackActive,
  };
}

function normalizeMode(value: string | undefined): InspectorMode {
  const token = normalizeToken(value, 'unknown');
  return token === 'isr' || token === 'ssr' || token === 'ssg' || token === 'csr'
    ? token
    : 'unknown';
}

function inferModeFromUrl(url: URL): InspectorMode {
  if (url.searchParams.has('__csr-shell')) return 'csr';
  return normalizeMode(url.searchParams.get('mode') ?? undefined);
}

function normalizeToken(value: string | undefined, fallback: string): string {
  const token = value?.trim();
  if (!token || token === '-') return fallback;
  return token.toLowerCase();
}

function readHeader(headers: Headers, name: string, fallback = '-'): string {
  return headers.get(name) || fallback;
}

function displayCache(mode: string, cache: string): string {
  if (mode === 'csr') return 'BYPASS · 降级';
  if (mode === 'ssr' && cache === 'bypass') return 'BYPASS · 实时';
  if (cache === 'hit') return 'HIT · 回放';
  if (cache === 'miss') return 'MISS · 生成';
  if (cache === 'stale') return 'STALE · 旧值';
  if (cache === 'revalidating') return 'REVALIDATING';
  return cache.toUpperCase();
}

function switchMode(mode: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('__csr-shell');
  url.searchParams.delete('__nojs');
  if (mode === 'csr') {
    url.searchParams.delete('mode');
    url.searchParams.set('__csr-shell', '1');
  } else {
    url.searchParams.set('mode', mode);
  }
  window.location.assign(url.toString());
}

function detailRow(label: string, value: string, danger = false): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd ${danger ? 'data-danger="true"' : ''}>${escapeHtml(value)}</dd>
    </div>
  `;
}

function summaryPill(label: string, value: string, kind: string, tone?: string): string {
  const attr = tone ? ` data-${kind}="${escapeAttr(tone)}"` : '';
  return `
    <span class="pill ${escapeAttr(kind)}"${attr}>
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const STYLE = `
  :host {
    all: initial;
    color-scheme: light dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .inspector {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    width: min(360px, calc(100vw - 32px));
    color: #111827;
    font-size: 12px;
    line-height: 1;
    pointer-events: none;
  }
  .summary,
  .panel {
    pointer-events: auto;
  }
  .summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    margin-left: auto;
    padding: 6px;
    border: 1px solid rgba(19, 24, 32, 0.1);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    color: #4b5563;
    box-shadow: 0 14px 36px rgba(15, 23, 42, 0.14);
    backdrop-filter: blur(16px);
    cursor: pointer;
  }
  .summary .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .summary small {
    color: currentColor;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0;
    opacity: 0.62;
    text-transform: uppercase;
  }
  .summary strong {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
  }
  .mode {
    background: #111827;
    color: #fff;
    font-weight: 700;
  }
  .mode[data-mode='ssr'] { background: #0f766e; }
  .mode[data-mode='ssg'] { background: #4338ca; }
  .mode[data-mode='csr'] { background: #b45309; }
  .strategy,
  .cache {
    background: #f3f4f6;
  }
  .cache[data-cache='hit'] {
    background: rgba(22, 163, 74, 0.12);
    color: #15803d;
  }
  .cache[data-cache='miss'] {
    background: rgba(234, 179, 8, 0.18);
    color: #a16207;
  }
  .cache[data-cache='bypass'] {
    background: rgba(14, 116, 144, 0.14);
    color: #0e7490;
  }
  .cache[data-cache='stale'],
  .cache[data-cache='revalidating'] {
    background: rgba(124, 58, 237, 0.14);
    color: #6d28d9;
  }
  .panel {
    margin-top: 8px;
    padding: 14px;
    border: 1px solid rgba(19, 24, 32, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.16);
    backdrop-filter: blur(18px);
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .panel-head strong {
    display: block;
    margin-top: 4px;
    font-size: 16px;
    letter-spacing: 0;
  }
  .mode-desc {
    display: block;
    margin-top: 5px;
    color: #6b7280;
    font-size: 12px;
    line-height: 1.4;
  }
  .eyebrow {
    margin: 0;
    color: #6b7280;
    font-size: 11px;
    text-transform: uppercase;
  }
  .status {
    align-self: flex-start;
    padding: 5px 8px;
    border-radius: 999px;
    background: rgba(22, 163, 74, 0.12);
    color: #15803d;
    font-weight: 700;
  }
  .details {
    display: grid;
    gap: 8px;
    margin: 0 0 12px;
  }
  .details div {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }
  .details dt {
    color: #6b7280;
  }
  .details dd {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: #111827;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .details dd[data-danger='true'] {
    color: #b45309;
    font-weight: 700;
  }
  .mode-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .mode-link {
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 10px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #f9fafb;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .mode-link span {
    font-weight: 700;
  }
  .mode-link small {
    color: #6b7280;
    font-size: 11px;
    line-height: 1.45;
    white-space: normal;
  }
  .mode-link:hover,
  .mode-link[data-active='true'] {
    border-color: #5b6cff;
    background: #eef2ff;
  }
  .help {
    margin: 10px 0 0;
    color: #6b7280;
    font-size: 11px;
    line-height: 1.5;
  }
  @media (max-width: 720px) {
    .inspector {
      right: 10px;
      bottom: 10px;
      width: min(340px, calc(100vw - 20px));
    }
    .summary {
      gap: 4px;
      padding: 5px;
    }
  }
  @media (prefers-color-scheme: dark) {
    .inspector { color: #e5e7eb; }
    .summary,
    .panel {
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(13, 17, 23, 0.92);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.36);
    }
    .strategy,
    .cache,
    .mode-link {
      background: rgba(255, 255, 255, 0.06);
    }
    .details dd { color: #e5e7eb; }
    .mode-desc { color: #9ca3af; }
    .mode-link {
      border-color: rgba(255, 255, 255, 0.12);
    }
    .mode-link:hover,
    .mode-link[data-active='true'] {
      background: rgba(91, 108, 255, 0.18);
    }
  }
`;
