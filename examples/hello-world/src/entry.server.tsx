import type { AutoServerCtx } from 'isr-engine/auto-observability';

export default {
  beforeRequest(_request: Request, { traceId }: AutoServerCtx) {
    return { requestId: traceId };
  },
  onResponse(response: Response, { requestId }: { requestId: string }) {
    const duration = response.headers.get('x-render-ms');
    response.headers.set(
      'server-timing',
      `isr;dur=${duration};desc="${encodeURIComponent(requestId)}"`
    );
  },
};
