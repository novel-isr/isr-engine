/**
 * ManifestLoader —— 实验定义动态拉取
 *
 * admin-server 暴露 GET /api/experiments/manifest，engine 启动 + 60s 轮询。
 * 运营在 admin-platform 改 weights / status，60s 内全 fleet 生效，**不重启 server**。
 *
 * 三种 fallback 策略（拉取失败时）：
 *   - 'cache'  → 用上一次拉成功的快照（默认；推荐）
 *   - 'static' → 退回 ssr.config.ts runtime.experiments 静态配置
 *   - 'empty'  → 关闭所有实验，全流量回 control
 *
 * status 字段语义（engine 解析）：
 *   - 'running' / undefined  → 正常分桶
 *   - 'paused' / 'killed'    → 强制回第一个 variant（control）
 *   - 'concluded'            → 同上 + admin-platform 高亮
 */
import { Logger } from '../logger/Logger';
import type { RuntimeExperimentConfig, RuntimeExperimentManifestConfig } from '../types/ISRConfig';

const logger = Logger.getInstance();

/** admin-server manifest 响应中单条实验定义的形状 */
export interface ManifestExperiment {
  variants: readonly string[];
  weights?: readonly number[];
  status?: 'running' | 'paused' | 'killed' | 'concluded';
  targeting?: {
    locales?: readonly string[];
    paths?: readonly string[];
  };
}

export interface ExperimentManifest {
  version: string;
  updatedAt: string;
  experiments: Record<string, ManifestExperiment>;
}

export interface ManifestLoaderOptions {
  /** admin-server endpoint（绝对 URL） */
  endpoint: string;
  /** 拉取间隔 ms；默认 60_000 */
  refreshIntervalMs?: number;
  /** 拉取失败回退策略 */
  fallbackOnError?: 'cache' | 'static' | 'empty';
  /** 鉴权头（Bearer / API key 之类） */
  authHeader?: { name: string; value: string };
  /** 测试用 fetcher */
  fetcher?: typeof fetch;
  /** 静态配置（fallback='static' 时用） */
  staticExperiments?: Record<string, RuntimeExperimentConfig>;
}

interface LoaderState {
  /** 最新有效快照（manifest 拉成功 / fallback 解析后的结果） */
  current: Record<string, RuntimeExperimentConfig>;
  /** 上次拉取响应的 ETag */
  etag: string | null;
  /** 拉取定时器 */
  pollTimer: NodeJS.Timeout | null;
  destroyed: boolean;
}

/**
 * 把 manifest 里的实验定义归一化为 engine 内部用的 RuntimeExperimentConfig。
 * killed / paused / concluded 状态的实验：**weights 强制变成 [100, 0, 0, ...]**，
 * 让所有用户回 control。不直接从 effective experiments 里剔除，保留 cacheTag /
 * exposure 上报能力（哪怕全部走 control，也能记录"实验在跑且强制 control"）。
 */
export function normalizeManifestExperiments(
  experiments: Record<string, ManifestExperiment>
): Record<string, RuntimeExperimentConfig> {
  const out: Record<string, RuntimeExperimentConfig> = {};
  for (const [key, exp] of Object.entries(experiments)) {
    const status = exp.status ?? 'running';
    if (status === 'paused' || status === 'killed' || status === 'concluded') {
      // 强制 control：第一个 variant 权重 100，其余 0
      const forcedWeights = exp.variants.map((_, i) => (i === 0 ? 100 : 0));
      out[key] = { variants: exp.variants, weights: forcedWeights };
    } else {
      out[key] = { variants: exp.variants, weights: exp.weights };
    }
  }
  return out;
}

export function createManifestLoader(options: ManifestLoaderOptions) {
  const refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  const fallbackOnError = options.fallbackOnError ?? 'cache';
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = options.endpoint;

  const state: LoaderState = {
    // 启动时先用静态配置兜底，避免首屏 manifest 还没拉到就有请求进来
    current: { ...(options.staticExperiments ?? {}) },
    etag: null,
    pollTimer: null,
    destroyed: false,
  };

  async function pullOnce(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
      };
      if (state.etag) headers['if-none-match'] = state.etag;
      if (options.authHeader) {
        headers[options.authHeader.name] = options.authHeader.value;
      }

      const res = await fetcher(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(3000),
      });

      // 304 → 配置没变，沿用 state.current
      if (res.status === 304) return;

      if (!res.ok) {
        applyFallback(`HTTP ${res.status}`);
        return;
      }

      const newEtag = res.headers.get('etag');
      if (newEtag) state.etag = newEtag;

      // admin-server 默认把响应包成 { status, code, data: {...} } envelope；
      // 直接返回 {experiments} 顶层的也支持。两种形态都能 parse
      const rawJson = (await res.json()) as ExperimentManifest | { data?: ExperimentManifest };
      const json: ExperimentManifest | undefined =
        rawJson && typeof rawJson === 'object' && 'data' in rawJson && rawJson.data
          ? (rawJson.data as ExperimentManifest)
          : (rawJson as ExperimentManifest);
      if (!json || typeof json !== 'object' || !json.experiments) {
        applyFallback('响应缺 experiments 字段');
        return;
      }

      state.current = normalizeManifestExperiments(json.experiments);
      logger.debug(
        `[ManifestLoader] 拉取成功 version=${json.version} 实验数=${Object.keys(state.current).length}`
      );
    } catch (err) {
      applyFallback(err instanceof Error ? err.message : String(err));
    }
  }

  function applyFallback(reason: string): void {
    switch (fallbackOnError) {
      case 'cache':
        // 沿用 state.current（启动时是 static experiments，后续是上次成功拉的）
        logger.warn(`[ManifestLoader] 拉取失败（${reason}），沿用 cache 快照`);
        break;
      case 'static':
        state.current = { ...(options.staticExperiments ?? {}) };
        logger.warn(`[ManifestLoader] 拉取失败（${reason}），回退到 static 配置`);
        break;
      case 'empty':
        state.current = {};
        logger.warn(`[ManifestLoader] 拉取失败（${reason}），关闭所有实验`);
        break;
    }
  }

  function schedulePoll(): void {
    if (state.destroyed) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      void pullOnce().finally(() => schedulePoll());
    }, refreshIntervalMs);
    state.pollTimer.unref?.();
  }

  return {
    /** 立即拉一次（启动期同步等待 + 后续异步轮询） */
    async init(): Promise<void> {
      await pullOnce();
      schedulePoll();
    },

    /**
     * 读取当前快照 —— 同步返回 ABVariantMiddleware 用。
     * 永远返回非 null（最差是 empty）；调用方不用 null 检查。
     */
    getCurrent(): Record<string, RuntimeExperimentConfig> {
      return state.current;
    },

    /** 销毁 loader（清定时器） */
    destroy(): void {
      state.destroyed = true;
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
    },
  };
}

export type ManifestLoaderInstance = ReturnType<typeof createManifestLoader>;

/**
 * 解析配置，决定是否创建 loader 实例。配置缺失 / 无 endpoint 返回 null。
 */
export function resolveManifestLoader(
  config: RuntimeExperimentManifestConfig | undefined,
  staticExperiments: Record<string, RuntimeExperimentConfig>,
  baseOrigin: string | undefined
): ManifestLoaderInstance | null {
  if (!config?.endpoint) return null;

  let endpoint = config.endpoint;
  if (endpoint.startsWith('/')) {
    if (!baseOrigin) {
      logger.warn('[ManifestLoader] endpoint 是相对路径但没有 baseOrigin，跳过 manifest 拉取');
      return null;
    }
    endpoint = baseOrigin.replace(/\/$/, '') + endpoint;
  }

  return createManifestLoader({
    endpoint,
    refreshIntervalMs: config.refreshIntervalMs,
    fallbackOnError: config.fallbackOnError,
    authHeader: config.authHeader,
    staticExperiments,
  });
}
