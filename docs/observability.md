# Observability

## 自动注入的响应头

每次请求 engine 自动注入：

| 头 | 值 |
|---|---|
| `x-trace-id` | 入站 `X-Request-Id` / `X-Trace-Id` 透传，否则生成 `t-{base36}-{rand}` |
| `x-render-ms` | 服务端渲染耗时（毫秒） |
| `X-Cache-Status` | `HIT` / `MISS` / `STALE` / `BYPASS` / `REVALIDATING` |
| `X-Cache-Stale-Reason` | STALE 时的具体原因：`swr-fresh` / `swr-bg-pending` / `swr-bg-failed-recent` |
| `X-Resolved-Mode` | 实际生效的 mode（`isr` / `ssr` / `ssg`） |
| `X-Mode-Source` | `config`（来自 ssr.config）/ `query-override`（来自 `?mode=`） |
| `X-Cache-Age` | 缓存条目年龄（秒；HIT/STALE 时） |
| `X-Cache-Key` | 缓存键（便于排错） |
| `X-Render-Strategy` | `csr-shell`（仅当 server 崩溃兜底时出现） |

**X-Cache-Stale-Reason 三态：**

- `swr-fresh` —— 刚进 SWR 窗口，bg 重渲还没启。**正常**。
- `swr-bg-pending` —— 后台重渲正在跑。**正常**，下次请求大概率 HIT。
- `swr-bg-failed-recent` —— 过去 60s 内 bg 重渲失败过（5xx / socket 超时 / connect error）。**不正常**，上游可能挂了，用户在持续看旧数据 → 立即查上游服务。

engine request context 的 `traceId` 自动贯穿整个请求生命周期（从 `X-Request-Id`/`X-Trace-Id` 读入，无则生成），所有 hook 都能拿到。

## Telemetry —— 统一上报配置

Engine 的公共配置只叫 `runtime.telemetry`。第一方 HTTP 上报、Sentry、Datadog、OTel
都属于同一条 telemetry pipeline，但层级不同：

- 自研/内部 HTTP 上报由 `events.endpoint` / `errors.endpoint` 驱动，这是第一方上报地址的唯一真值源。
- Datadog / OTel 是额外 collector exporter，适合把 server trace/metric 送到外部采集器。
- Sentry 这种包含 SDK、issue grouping、source map、release health、performance 的平台是 integration。

不再拆成 `runtime.observability` 和 `runtime.sentry` 两套顶层概念。

第一性原则：

- engine 拥有生命周期：首屏、导航、Web Vitals、全局错误、Server Action 失败、服务端渲染异常。
- engine 不绑定 vendor SDK，也不 import 业务 SDK；它只根据 endpoint、exporter 和 integration 配置工作。
- endpoint 是具体上报地址，可以是相对路径或完整 URL；`services.telemetry` 是这些相对路径的 base URL。
- Sentry 是 integration，用于 SDK 接入、issue grouping、source map、APM、trace 和告警。
- exporter 和 integration 可以同时开启，用于迁移、双写或第一方数仓 + Sentry 排障并存。
  如果只想二选一，显式关闭不需要的 exporter 或 integration；engine 不做隐式替换。
- 额外 exporter / integration 失败不会阻断第一方 endpoint、渲染或业务 hooks。

`@novel-isr/analytics` 与 `@novel-isr/error-reporting` 是独立 SDK，给非 engine 应用或
自定义前端使用；engine 自身不会动态 import 这些包，也不会把它们变成隐式依赖。

> ⚠️ 下面示例读 `process.env.NODE_ENV`。**绝不要把 NODE_ENV 写进 `.env` 文件** —— Vite 8 会 hijack 让 `vite build` 回退 dev 模式致 React 19 SSG `jsxDEV is not a function` 全崩。NODE_ENV 走 K8s ConfigMap / Docker `ENV` / `pnpm start` 前缀注入，详见 [deployment.md](./deployment.md#-node_env-禁忌绝不写-env-文件)。

```ts
// ssr.config.ts
export default {
  runtime: {
    services: {
      api: process.env.API_URL ?? 'https://admin.example.com',
      telemetry: process.env.TELEMETRY_API_URL ?? 'https://admin.example.com',
    },
    telemetry: {
      app: 'novel-rating',
      environment: process.env.NODE_ENV,
      release: process.env.APP_VERSION,
      includeQueryString: false,
      events: {
        endpoint: '/api/observability/analytics',
        trackInitialPage: true,
        sampleRate: 1,
        batchSize: 20,
        flushIntervalMs: 3000,
        maxQueueSize: 500,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 30000,
      },
      errors: {
        endpoint: '/api/observability/errors',
        captureResourceErrors: true,
        sampleRate: 1,
        batchSize: 10,
        flushIntervalMs: 3000,
        maxQueueSize: 200,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 30000,
      },
      webVitals: { enabled: true },
      exporters: [],
      integrations: {
        sentry: {
          enabled: process.env.SENTRY_ENABLED === 'true',
          dsn: process.env.SENTRY_DSN,
          tracesSampleRate: 0.1,
          environment: process.env.NODE_ENV,
          release: process.env.APP_VERSION,
        },
      },
    },
  },
};
```

自动接入点：

- 首屏：engine endpoint uploader 上报一次初始 `page_view`。
- 客户端导航：engine 拦截 `pushState` / `replaceState` / `popstate` 后上报 `page_view`。
- Web Vitals：开启 `telemetry.webVitals.enabled` 后采集 FCP、LCP、INP、CLS、TTFB 的原始观测值。
- 全局错误：engine endpoint uploader 注册 `window.error` / `unhandledrejection`。
- Server Action：action 返回 `{ ok:false }` 时上报 `source=server-action` 和 `actionId`。
- 服务端渲染异常：`runtime.telemetry.errors` 配置存在时，`onError`
  会 fire-and-forget 上报 `source=server-render`，同时保留业务自定义 `onError`。

生产约束：

- endpoint 为空时是 no-op transport，不刷 console，不阻塞页面。
- 默认不会上报完整 query/hash；只有显式 `includeQueryString: true` 才上报 query。
- 浏览器只上传 raw fact，例如 `{ name: 'INP', value: 260 }`；p75/p95、评级、慢页面归因和 release 对比由后端 / dashboard 聚合。
- 浏览器上报失败会回填有界队列，并用指数退避 + online 恢复重试，不影响水合、导航和用户交互。
- 服务端错误上报是非阻塞 fire-and-forget；失败不会改变 SSR/ISR/RSC 的异常语义。
- `src/entry.tsx beforeStart` 仍可接业务自定义 SDK；平台默认链路是 `runtime.telemetry`，
  不是锁定供应商。

## 业务显式埋点 API

自动采集只覆盖框架生命周期。业务关键动作、领域错误、指定交互耗时应显式上报，但业务代码不应该关心 endpoint、重试、采样、队列或第三方 SDK。页面或 Client Component 直接使用 runtime facade。

`measure()` 只上报一次原始观测值，不在浏览器里算 p95、趋势、慢页面排行或告警阈值。成熟做法是前端发送 raw fact，后端 / dashboard 按 route、release、device、tenant、用户分群聚合。

```tsx
'use client';

import { capture, measure, setTelemetryUser, track } from '@novel-isr/engine/runtime';

export function RatingButton({ bookId, userId }: { bookId: string; userId?: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        setTelemetryUser(userId ? { id: userId } : null);
        const startedAt = performance.now();

        try {
          await submitRating(bookId, 5);
          track('rating.submit', { bookId, score: 5 }, { tags: { feature: 'rating' } });
        } catch (error) {
          capture(error, {
            source: 'rating-button',
            tags: { feature: 'rating' },
            extra: { bookId },
          });
        } finally {
          measure('rating.submit.latency', performance.now() - startedAt, {
            unit: 'ms',
            tags: { feature: 'rating' },
          });
        }
      }}
    >
      评分
    </button>
  );
}
```

这些 API 复用 engine 自动安装的同一条 first-party endpoint transport：

- `track(name, properties, { tags })` → `runtime.telemetry.events.endpoint`，用于业务事件。
- `measure(name, value, { unit, properties, tags })` → 同一个 events endpoint，事件名为 `metric`，只上传原始数值。
- `capture(error, { source, tags, extra, fingerprint })` → `runtime.telemetry.errors.endpoint`，用于业务错误或错误边界。
- `page(url)` → 同一个 events endpoint，事件名为 `page_view`；普通导航已自动处理，自定义 router 才需要手动调用。
- `setTelemetryUser(user)` → 给之后的 events/errors 增加用户、租户、分群上下文。
- `flushTelemetry()` → 主动 flush 队列，适合登出、支付跳转或关键页面离开前。

如果没有配置 telemetry 或 endpoint 不可用，这些 API 是 no-op，不会影响 SSR/RSC/CSR。

## Sentry / Datadog / OTel

Sentry 是第三方错误监控 / APM 平台 integration，不是单独的顶层配置入口，也不是普通 HTTP exporter。生产中可以：

- 只用第一方 HTTP 上报：配置 `runtime.telemetry.events.endpoint` / `runtime.telemetry.errors.endpoint`，打到 admin-server 或公司内部采集服务。
- 同时接 Sentry：配置 `runtime.telemetry.integrations.sentry.enabled=true` 和 `dsn`，让 engine 把服务端错误/trace 映射给 Sentry adapter。
- 只接 Sentry：关闭 `runtime.telemetry.events/errors`；这是显式选择，不是 engine 隐式替换。

不要在 `src/entry.tsx` 重复手写同一份第一方 PV / error endpoint 上传；默认生命周期已经由
`runtime.telemetry` 接管。

```tsx
// src/entry.server.tsx
import * as Sentry from '@sentry/node';
import { createSentryServerHooks } from '@novel-isr/engine/adapters/observability';

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
export default createSentryServerHooks({ Sentry });
// 自动：
//   beforeRequest 开 span(op='http.server', tag.traceId)
//   onResponse  关 span + setHttpStatus
//   onError     captureException + tag.traceId + extra.url
```

浏览器侧常规业务上报优先使用 `track/capture/measure`。`src/entry.tsx` 的高级 hooks 会收到 engine 注入的 `telemetry` facade，适合补充上下文和业务语义，不适合重复上传常规 page_view/error：

```tsx
// src/entry.tsx
export default {
  devInspector: true,
  beforeStart({ telemetry }) {
    telemetry.setUser(readPublicUser());
    telemetry.track('app.client_ready', { source: 'entry' });
  },
  onNavigate(url, { telemetry }) {
    telemetry.track('navigation.section_enter', {
      path: url.pathname,
      section: url.pathname.split('/').filter(Boolean)[0] ?? 'home',
    });
  },
  onActionError(error, actionId, { telemetry }) {
    // engine 已自动 capture 这次 Server Action error；这里只补产品漏斗事件。
    telemetry.track('server_action.failure_seen', {
      actionId,
      message: error instanceof Error ? error.message : String(error),
    });
  },
};
```

只有需要接第三方浏览器 SDK 的 breadcrumb、release health 或专属 performance 时，才在 `src/entry.tsx` 额外使用第三方 hooks：

```tsx
// src/entry.tsx
import * as Sentry from '@sentry/browser';
import { createSentryClientHooks } from '@novel-isr/engine/adapters/observability';

export default createSentryClientHooks({
  Sentry,
  init: () => Sentry.init({ dsn: 'https://…', tracesSampleRate: 0.1 }),
  webVitals: true,   // 可选：把 raw web-vitals 同步给 Sentry metrics；用户需 pnpm add web-vitals
});
```

不要把第一方 endpoint 上传也写进这些 hook；否则会和 engine 自动采集重复。

### Datadog APM

```tsx
import tracer from 'dd-trace';
import { createDatadogServerHooks } from '@novel-isr/engine/adapters/observability';

tracer.init({ service: 'my-app', env: 'prod' });
export default createDatadogServerHooks({ tracer });
```

### OpenTelemetry

```tsx
import { trace } from '@opentelemetry/api';
import { createOtelServerHooks } from '@novel-isr/engine/adapters/observability';

export default createOtelServerHooks({ tracer: trace.getTracer('my-app') });
```

输出到任意 OTLP collector（Jaeger / Zipkin / Tempo / Honeycomb…）。

### 关键点

- Adapter 会写入 `__sentrySpan` / `__ddSpan` / `__otelSpan` 到 ctx，方便业务 hook 进一步丰富
- 仍可手写自定义 hook —— adapter 是糖，不是锁
- 树摇友好：只导入 Sentry adapter 时，Datadog/OTel 不会进 bundle

## Prometheus

`/metrics` 端点：dev 默认开启；prod 需显式配置 `server.ops.metrics.enabled = true`。
内容是 prom-client 文本格式：

- `isr_http_requests_total{method,route,status,mode,cache}` counter
- `isr_http_request_duration_seconds{...}` histogram（桶覆盖 1ms - 5s）
- `isr_cache_entries{backend}` / `isr_cache_revalidating_inflight` / `isr_cache_hits_total{status}`
- `isr_invalidator_runs_total{kind,target}` / `isr_invalidator_failures_total{kind,target}` —— `target` 是归一化路径（`/books/:id`）或 tag 名，让 Grafana 能定位到具体业务对象
- `isr_l2_read_timeouts_total` —— L2 (Redis) 读超时被降级为 miss 的次数，区分「真 miss」vs「Redis 抖动」
- `isr_process_*` 默认采集（CPU / RSS / event loop lag）

业务自家 metric 可注册到同一 registry：

```ts
import { promRegistry } from '@novel-isr/engine';
import { Counter } from 'prom-client';

const orderCounter = new Counter({
  name: 'app_orders_total',
  help: '...',
  registers: [promRegistry],
});
```

## ISR 缓存观测 —— 流量视角 vs 库存视角

| 视角 | 端点 | 回答的问题 |
|------|------|------------|
| **流量** | `/metrics`（Prometheus）| 「过去 5min 有多少 STALE 响应、按路由分布」、「失效失败率」 |
| **库存** | `/__isr/cache/inventory`（admin JSON）| 「**现在这一刻**缓存里有什么、哪些已经 stale 但没人请求」、「`/books/123` 上次什么时候被 revalidate」 |

两者互补，缺一不可。冷门页 `/book/9999` 已 stale 半天没人访问 → Prometheus 看不见；inventory 一查就有。

### `/__isr/cache/inventory` admin 端点

dev 默认 public 开放；prod 默认上线 + 强制 token（不配 token 自动 disable + 出 warning）。

```bash
# dev：本地直查
curl http://localhost:3000/__isr/cache/inventory | jq

# prod：必须带 ops.authToken
curl -H "Authorization: Bearer $ISR_OPS_TOKEN" \
  https://your.site/__isr/cache/inventory?status=stale | jq
```

**查询参数：**

| 参数 | 默认 | 含义 |
|------|------|------|
| `status` | `all` | `fresh` / `stale` / `expired` / `all` —— L1 状态过滤 |
| `limit` | 100 | L1 返回条目上限（硬上限 1000） |
| `l2` | `true` | 是否包含 L2（Redis）SCAN 视图。`memory` 模式下永远空 |
| `l2Limit` | 200 | L2 SCAN 返回上限（硬上限 500）。L2 用 SCAN 非阻塞游标，不会卡集群 |

**响应字段：**

```json
{
  "now": 1715760000000,
  "backend": "hybrid",          // memory 或 hybrid
  "size": 234,                   // L1 当前条目数
  "max": 1000,                   // L1 容量
  "filtered": 12,                // L1 过滤后条目数
  "entries": [                   // L1 条目（含 fresh/stale/expired 状态）
    { "key": "GET:/books/1", "storedAt": ..., "expiresAt": ..., "ageSeconds": 30,
      "status": "stale", "sizeBytes": 12450, "tags": ["books"] }
  ],
  "invalidations": [             // 最近 invalidate 记录（per-target lastInvalidatedMs）
    { "target": "tag:books", "lastInvalidatedMs": ..., "ageSeconds": 12 }
  ],
  "l2": {                        // hybrid 模式有内容；memory 模式 items=[]
    "scanned": 234,
    "items": [
      { "key": "GET:/cold-page", "sizeBytes": 800, "ttlSecondsRemaining": 7200,
        "onlyInL2": true }     // true = 在 Redis 但不在本 pod L1（其他 pod 写的或 LRU 已淘汰）
    ]
  }
}
```

`server.ops` 配置示例：

```ts
// ssr.config.ts
{
  server: {
    ops: {
      authToken: process.env.ISR_OPS_TOKEN,
      tokenHeader: 'x-isr-admin-token',
      metrics: { enabled: true, public: false },
      inventory: { enabled: true, public: false },  // prod 默认即是这个值，写出来更清晰
    },
  },
}
```

鉴权支持 `Authorization: Bearer <token>` 或自定义 header（默认 `x-isr-admin-token`）。
没配 `authToken` 时，metrics 和 inventory 都会自动 disable + 启动日志 warning。

### 失效不暴露公共端点

生产缓存失效不暴露「清空全部缓存」端点。请在 Server Action 或后台任务里调用
`revalidatePath` / `revalidateTag`，多实例广播由 `runtime.redis` 接管。
