/**
 * createSsgPostBuildPlugin —— vite 构建结束后自动跑 SSG 预渲染
 *
 * 让 `vite build` 成为唯一的构建入口（用户只需在 vite.config.ts 用 createIsrPlugin），
 * 不再需要 `novel-isr build` 这种 CLI 包一层。
 *
 * 实现要点：
 *   - 在 plugin-rsc 的多 pass 构建里，client environment 是最后一轮
 *   - 仅在 client 那一轮的 closeBundle 里跑 SSG（避免重复触发）
 *   - 跑 SSG 需要 dist/rsc/index.js 已就绪 —— plugin-rsc 保证 client 是最后一环
 */
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import type { Plugin } from 'vite';

import type { ISRConfig } from '../types';
import { logger } from '../logger';
import { spiderSsgRoutes, extractSsgRoutes, type FetchHandler } from '@/ssg/spider';
import { loadConfig } from '../config/loadConfig';

export function createSsgPostBuildPlugin(explicitConfig: ISRConfig | undefined): Plugin {
  let root = process.cwd();

  async function runSsg(): Promise<void> {
    let userConfig: ISRConfig | undefined = explicitConfig;
    if (!userConfig || Object.keys(userConfig).length === 0) {
      try {
        userConfig = (await loadConfig({ cwd: root })) as ISRConfig;
      } catch (err) {
        logger.warn('[SSG] ssr.config.ts 加载失败，跳过 SSG 预生成', err);
        return;
      }
    }
    if (!userConfig) return;

    const ssgRoutes = await extractSsgRoutes(userConfig);
    if (ssgRoutes.length === 0) return;

    const rscDistEntry = path.resolve(root, 'dist/rsc/index.js');
    const clientDir = path.resolve(root, 'dist/client');
    if (!existsSync(rscDistEntry)) {
      logger.warn('[SSG] 未找到 dist/rsc/index.js，跳过 SSG 预生成');
      return;
    }

    logger.info(`[SSG] 预生成 ${ssgRoutes.length} 个路由（${ssgRoutes.join(', ')}）...`);
    const mod = (await import(/* @vite-ignore */ rscDistEntry)) as {
      default?: FetchHandler;
      fetch?: FetchHandler['fetch'];
    };
    const fetchFn = mod.default?.fetch || mod.fetch;
    if (!fetchFn) {
      throw new Error('dist/rsc/index.js 未导出 { fetch } 或 default.fetch');
    }
    const handler: FetchHandler = { fetch: fetchFn.bind(mod.default ?? mod) };

    const ssgCfg = userConfig.ssg ?? {};
    const result = await spiderSsgRoutes({
      handler,
      routes: ssgRoutes,
      outDir: clientDir,
      options: {
        concurrency: ssgCfg.concurrent ?? 3,
        continueOnError: true,
        // P0 fail-loud 加固：单页 timeout / retry / 整体失败率阈值
        // 用户可在 ssr.config.ts 的 ssg: {...} 覆盖；缺省值在 spider.ts 内
        requestTimeoutMs: ssgCfg.requestTimeoutMs,
        maxRetries: ssgCfg.maxRetries,
        retryBaseDelayMs: ssgCfg.retryBaseDelayMs,
        failBuildThreshold: ssgCfg.failBuildThreshold,
      },
    });

    logger.info(
      `[SSG] 预生成完成: ${result.successful} 成功, ${result.failed} 失败, 共 ${result.total}` +
        ` (失败率 ${(result.failureRate * 100).toFixed(1)}%)`
    );
  }

  /**
   * 同 build 一并产 dist/spa/index.html ——
   * 复用 dist/client/ 已有的 client bundle + CSS chunks，触发 entry.tsx 的 SPA 路径
   * 部署：Nginx error_page 指向此文件，origin 5xx 时浏览器加载即启动 SPA fallback
   */
  async function generateSpaShell(): Promise<void> {
    const ssrManifest = path.resolve(root, 'dist/ssr/__vite_rsc_assets_manifest.js');
    const spaDir = path.resolve(root, 'dist/spa');
    if (!existsSync(ssrManifest)) {
      logger.warn('[SPA] 未找到 dist/ssr/__vite_rsc_assets_manifest.js，跳过 SPA shell 生成');
      return;
    }

    const m = (await import(/* @vite-ignore */ ssrManifest)) as {
      default: {
        bootstrapScriptContent?: string;
        clientReferenceDeps?: Record<string, { css?: string[] }>;
        serverResources?: Record<string, { css?: string[] }>;
      };
    };
    const manifest = m.default;
    const bootstrap = manifest.bootstrapScriptContent ?? '';
    // 收集所有 CSS chunks（client + server resources）
    const cssSet = new Set<string>();
    for (const group of [manifest.clientReferenceDeps, manifest.serverResources]) {
      if (!group) continue;
      for (const id of Object.keys(group)) {
        for (const href of group[id].css ?? []) cssSet.add(href);
      }
    }

    const linkTags = Array.from(cssSet)
      .map(h => `<link rel="stylesheet" href="${h}" />`)
      .join('\n  ');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>正在加载…</title>
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  ${linkTags}
</head>
<body>
  <script>self.__SPA_MODE__=1;${bootstrap}</script>
</body>
</html>
`;
    await fs.mkdir(spaDir, { recursive: true });
    await fs.writeFile(path.join(spaDir, 'index.html'), html, 'utf-8');
    logger.info(`[SPA] dist/spa/index.html 已生成 (${cssSet.size} 个 CSS chunks 注入)`);
  }

  return {
    name: 'novel-isr:ssg-post-build',
    apply: 'build',
    configResolved(resolved) {
      root = resolved.root;
    },
    /**
     * vite 8 的 buildApp hook —— 在 builder.buildApp() 完成所有环境后调用一次。
     * 这是跑 SSG 的最佳时机：dist/{rsc,client,ssr}/* 全部就绪，manifest 也已生成。
     * 比挂在 closeBundle 里要稳定（closeBundle 在每个环境单独触发，且 manifest 不一定 ready）
     */
    buildApp: {
      order: 'post',
      async handler() {
        await runSsg();
        await generateSpaShell();
      },
    },
  };
}
