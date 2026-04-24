# Observability

## 自动注入的响应头

每次请求 engine 自动注入：

| 头 | 值 |
|---|---|
| `x-trace-id` | 入站 `X-Request-Id` / `X-Trace-Id` 透传，否则生成 `t-{base36}-{rand}` |
| `x-render-ms` | 服务端渲染耗时（毫秒） |
| `X-Cache-Status` | `HIT` / `MISS` / `STALE` / `BYPASS` / `REVALIDATING` |
| `X-Resolved-Mode` | 实际生效的 mode（`isr` / `ssr` / `ssg`） |
| `X-Mode-Source` | `config`（来自 ssr.config）/ `query-override`（来自 `?mode=`） |
| `X-Cache-Age` | 缓存条目年龄（秒；HIT/STALE 时） |
| `X-Cache-Key` | 缓存键（便于排错） |
| `X-Render-Strategy` | `csr-shell`（仅当 server 崩溃兜底时出现） |

`baseline.traceId` 自动贯穿整个请求生命周期（从 `X-Request-Id`/`X-Trace-Id` 读入，无则生成），所有 hook 都能拿到。

## Sentry / Datadog / OTel —— 一行接入

Engine 不绑定任何 SDK，但提供**预制 hook 工厂**，避免每个项目重复写 span 模板。

### Sentry

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

浏览器侧：

```tsx
// src/entry.tsx
import * as Sentry from '@sentry/browser';
import { createSentryClientHooks } from '@novel-isr/engine/adapters/observability';

export default createSentryClientHooks({
  Sentry,
  init: () => Sentry.init({ dsn: 'https://…', tracesSampleRate: 0.1 }),
  webVitals: true,   // 自动接 web-vitals（用户需 pnpm add web-vitals）
});
```

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

`/metrics` 端点：dev 默认开启；prod 需显式配置 `server.admin.metrics.enabled = true`。内容是 prom-client 文本格式：

- `isr_http_requests_total{method,route,status,mode,cache}` counter
- `isr_http_request_duration_seconds{...}` histogram（桶覆盖 1ms - 5s）
- `isr_cache_entries{backend}` / `isr_cache_revalidating_inflight` / `isr_cache_hits_total{status}`
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

## ISR 缓存观测端点

| 端点 | 内容 |
|---|---|
| `/__isr/stats` | JSON `{ size, max, revalidating }` |
| `/__isr/clear` | POST 清空缓存 |

dev 模式默认开启；prod 默认关闭。开启时建议配 `server.admin.authToken`：

```ts
// ssr.config.ts
{
  server: {
    admin: {
      authToken: process.env.ISR_ADMIN_TOKEN,
      metrics: { enabled: true, public: false },
      stats: { enabled: true, public: false },
      clear: { enabled: false, public: false },
    },
  },
}
```

鉴权支持 `Authorization: Bearer <token>` 或自定义 header（默认 `x-isr-admin-token`）。

## 审计日志（PII redacted NDJSON）

```ts
import { createAuditLogger } from '@novel-isr/engine';

const audit = createAuditLogger({ file: '/var/log/audit.ndjson' });
audit.log({ action: 'login', userId, email });   // email 自动 redact
```

PII 模式覆盖 email / phone / JWT / AWS key / GitHub token 等。详细规则看 `src/security/redactPii.ts`。
