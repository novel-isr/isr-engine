/**
 * defineSiteHooks 单元测试
 *
 * 覆盖：
 *   - locale 检测：cookie / Accept-Language / fallback
 *   - SEO 静态条目 + 远程条目 + custom resolver
 *   - 路由 :param 占位符匹配
 *   - intl loader 默认 fallback / RTL 标记
 *   - canonical 自动用 site + pattern
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyRuntimeToServerHooks,
  createAdminIntlLoader,
  createAdminSeoLoader,
  defineAdminSiteHooks,
  defineSiteHooks,
  type ServerHooksOutput,
} from '../defaults/runtime/defineSiteHooks';

const engineCtx = { traceId: 't', startedAt: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('defineSiteHooks: locale detection', () => {
  it('cookie locale 优先', async () => {
    const hooks = defineSiteHooks({});
    const req = new Request('http://x.com', { headers: { cookie: 'a=b; locale=fr; c=d' } });
    const ext = await hooks.beforeRequest(req, engineCtx);
    expect(ext.locale).toBe('fr');
  });

  it('无 cookie 时按 accept-language 前缀', async () => {
    const hooks = defineSiteHooks({});
    expect(
      (
        await hooks.beforeRequest(
          new Request('http://x.com', { headers: { 'accept-language': 'en-US,en' } }),
          engineCtx
        )
      ).locale
    ).toBe('en');
    expect(
      (
        await hooks.beforeRequest(
          new Request('http://x.com', { headers: { 'accept-language': 'zh-CN,zh' } }),
          engineCtx
        )
      ).locale
    ).toBe('zh-CN');
  });

  it('都无时用 defaultLocale', async () => {
    const hooks = defineSiteHooks({ intl: { defaultLocale: 'ja' } });
    const ext = await hooks.beforeRequest(new Request('http://x.com'), engineCtx);
    expect(ext.locale).toBe('ja');
  });

  it('自定义 detect 完全覆盖', async () => {
    const hooks = defineSiteHooks({ intl: { detect: () => 'custom' } });
    const ext = await hooks.beforeRequest(
      new Request('http://x.com', { headers: { cookie: 'locale=zh' } }),
      engineCtx
    );
    expect(ext.locale).toBe('custom');
  });

  it('beforeRequest 用户扩展字段合并', async () => {
    const hooks = defineSiteHooks({ beforeRequest: () => ({ user: 'u1' }) });
    const ext = await hooks.beforeRequest(new Request('http://x.com'), engineCtx);
    expect(ext).toMatchObject({ locale: 'zh-CN', user: 'u1' });
  });
});

describe('defineSiteHooks: SEO 路由表', () => {
  it('静态条目按 pattern 命中 + canonical 自动补齐', async () => {
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        seo: {
          '/about': { title: 'About', description: 'd' },
        },
      }),
      { site: 'https://x.com' }
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/about'));
    expect(meta?.title).toBe('About');
    expect(meta?.canonical).toBe('https://x.com/about');
  });

  it(':param 占位符 + 远程 endpoint + transform', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { name: '诡秘之主' } }), { status: 200 })
      );
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        seo: {
          '/books/:id': {
            endpoint: '/api/books/{id}',
            transform: (data, params) => ({
              title: `${(data as { data: { name: string } }).data.name} · ${params.id}`,
              ogType: 'article',
            }),
          },
        },
      }),
      { api: 'http://api.x' }
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/books/42'));
    expect(meta?.title).toBe('诡秘之主 · 42');
    expect(fetchSpy).toHaveBeenCalledWith('http://api.x/api/books/42');
  });

  it('未匹配返回 null', async () => {
    const hooks = defineSiteHooks({ seo: { '/': { title: 'home' } } });
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/no-match'));
    expect(meta).toBeNull();
  });

  it('远程拉取失败 → fallback null', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        seo: {
          '/books/:id': {
            endpoint: '/api/books/{id}',
            transform: () => ({ title: 'x' }),
          },
        },
      }),
      { api: 'http://api.x' }
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/books/1'));
    expect(meta).toBeNull();
  });

  it('自定义 resolver function 直接返回 PageSeoMeta', async () => {
    const hooks = defineSiteHooks({
      seo: {
        '/custom': () => ({ title: 'CUSTOM' }),
      },
    });
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/custom'));
    expect(meta?.title).toBe('CUSTOM');
  });
});

describe('defineSiteHooks: i18n loader', () => {
  it('endpoint 模板替换 + 返回 messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { hello: '你好' } }), { status: 200 })
    );
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        intl: { endpoint: '/api/i18n?locale={locale}' },
      }),
      { api: 'http://api.x' }
    );
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=zh-CN' } })
    );
    expect(intl?.locale).toBe('zh-CN');
    expect(intl?.messages).toEqual({ hello: '你好' });
    expect(intl?.direction).toBe('ltr');
  });

  it('RTL 语言自动标记', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('null', { status: 200 }));
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({ intl: { endpoint: '/x?l={locale}' } }),
      { api: 'http://api.x' }
    );
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=ar' } })
    );
    expect(intl?.direction).toBe('rtl');
  });

  it('endpoint + load 都不传 → 空 messages', async () => {
    const hooks = defineSiteHooks({});
    const intl = await hooks.loadIntl(new Request('http://x.com'));
    expect(intl?.messages).toEqual({});
  });

  it('自定义 load 函数完全覆盖', async () => {
    const hooks = defineSiteHooks({
      intl: { load: async loc => ({ locale: loc, messages: { custom: 1 } }) },
    });
    const intl = await hooks.loadIntl(new Request('http://x.com'));
    expect(intl?.messages).toEqual({ custom: 1 });
  });
});

describe('admin loaders', () => {
  it('createAdminIntlLoader 使用 runtime.services.i18n 拉远端并展开 dotted keys', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ strings: { 'home.title': '首页' } }), { status: 200 })
      );
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        intl: {
          locales: ['zh', 'en'],
          defaultLocale: 'zh',
          load: createAdminIntlLoader({
            endpoint: '/api/i18n/{locale}/manifest',
            fallbackMessages: { zh: { 'home.title': '本地首页' } },
            defaultLocale: 'zh',
          }),
        },
      }),
      { services: { api: 'http://api.x', i18n: 'http://i18n.x' } }
    );
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=zh' } })
    );
    expect(fetchSpy).toHaveBeenCalledWith('http://i18n.x/api/i18n/zh/manifest', expect.any(Object));
    expect(intl?.messages).toEqual({ home: { title: '首页' } });
    expect(intl?.source).toBe('remote');
  });

  it('createAdminIntlLoader 远端失败时使用本地 fallback 与默认 locale', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        intl: {
          locales: ['zh', 'en'],
          defaultLocale: 'zh',
          load: createAdminIntlLoader({
            fallbackMessages: { zh: { 'home.title': '本地首页' } },
            defaultLocale: 'zh',
          }),
        },
      }),
      { services: { i18n: 'http://i18n.x' } }
    );
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=fr' } })
    );
    expect(intl?.locale).toBe('zh');
    expect(intl?.messages).toEqual({ home: { title: '本地首页' } });
    expect(intl?.source).toBe('local-fallback');
  });

  it('createAdminSeoLoader 支持显式 baseUrl 覆盖 runtime.services.seo', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { title: '远端 SEO' } }), { status: 200 })
      );
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        seo: {
          '/*': {
            load: createAdminSeoLoader({
              endpoint: '/api/seo?path={pathname}',
              baseUrl: 'http://admin.x',
              fallbackEntries: [{ path: '/', title: '本地 SEO', group: 'marketing' }],
            }),
          },
        },
      }),
      { services: { seo: 'http://seo.x' } }
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/'));
    expect(fetchSpy).toHaveBeenCalledWith('http://admin.x/api/seo?path=%2F', expect.any(Object));
    expect(meta?.title).toBe('远端 SEO');
  });

  it('createAdminSeoLoader 远端失败时按 pathname 命中本地 fallback 并去除管理字段', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const hooks = applyRuntimeToServerHooks(
      defineSiteHooks({
        seo: {
          '/*': {
            load: createAdminSeoLoader({
              fallbackEntries: [{ path: '/about', title: '关于', group: 'system' }],
            }),
          },
        },
      }),
      { services: { seo: 'http://seo.x' } }
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/about'));
    expect(meta).toEqual({ title: '关于' });
  });

  it('defineAdminSiteHooks 从 runtime.i18n/runtime.seo 生成商业默认 SiteHooks', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const hooks = applyRuntimeToServerHooks(defineAdminSiteHooks(), {
      services: { api: 'http://api.x' },
      i18n: {
        locales: ['zh', 'en'],
        defaultLocale: 'zh',
        fallbackLocal: { zh: { 'home.title': '首页' } },
      },
      seo: { fallbackLocal: [{ path: '/', title: '首页 SEO' }] },
    });
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=zh' } })
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/'));
    expect(intl?.messages).toEqual({ home: { title: '首页' } });
    expect(intl?.source).toBe('local-fallback');
    expect(meta).toEqual({ title: '首页 SEO' });
  });

  it('applyRuntimeToServerHooks 在没有 entry.server 数据 loader 时自动使用 runtime 配置', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const hooks = applyRuntimeToServerHooks(
      {
        beforeRequest: (req: Request) => ({
          tenantId: req.headers.get('x-tenant-id') ?? 'public',
        }),
      },
      {
        services: { api: 'http://api.x' },
        i18n: {
          locales: ['zh', 'en'],
          defaultLocale: 'zh',
          fallbackLocal: { zh: { 'home.title': '首页' } },
        },
        seo: { fallbackLocal: [{ path: '/', title: '首页 SEO' }] },
      }
    ) as unknown as ServerHooksOutput;
    const ctx = await hooks.beforeRequest(
      new Request('http://x.com', {
        headers: { cookie: 'locale=zh', 'x-tenant-id': 'tenant-a' },
      }),
      { traceId: 't1', startedAt: 1 }
    );
    const intl = await hooks.loadIntl(
      new Request('http://x.com', { headers: { cookie: 'locale=zh' } })
    );
    const meta = await hooks.loadSeoMeta(new Request('http://x.com/'));
    expect(ctx).toEqual({ locale: 'zh', tenantId: 'tenant-a' });
    expect(intl?.messages).toEqual({ home: { title: '首页' } });
    expect(meta).toEqual({ title: '首页 SEO' });
  });
});

describe('defineSiteHooks: onError', () => {
  it('默认 console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hooks = defineSiteHooks({});
    hooks.onError(new Error('x'), new Request('http://x.com'), { traceId: 't1' });
    expect(spy).toHaveBeenCalledWith(
      '[onError]',
      expect.objectContaining({ traceId: 't1', msg: 'x' })
    );
  });

  it('自定义 onError 完全覆盖', () => {
    const cb = vi.fn();
    const hooks = defineSiteHooks({ onError: cb });
    const err = new Error('boom');
    hooks.onError(err, new Request('http://x.com'), { traceId: 't' });
    expect(cb).toHaveBeenCalledWith(err, expect.any(Request), { traceId: 't' });
  });
});
