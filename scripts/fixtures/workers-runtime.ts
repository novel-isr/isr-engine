import { toCloudflareWorker } from '@novel-isr/engine/adapters/runtime';
import { getEdgeContext } from '@novel-isr/engine/runtime';

interface Bindings {
  MARKER: string;
  HOST: { fetch(input: string): Promise<Response> };
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export default toCloudflareWorker<Bindings>(
  {
    fetch(request, passedContext) {
      const edge = getEdgeContext<Bindings>(request);
      check(edge && edge === passedContext, 'handler context identity');
      check(edge.env.MARKER === 'workerd-binding', 'binding value');
      check(getEdgeContext(request.clone()) === undefined, 'clone must have no context');
      const path = new URL(request.url).pathname;
      if (path === '/synchronous') return new Response(edge.env.MARKER);
      return (async () => {
        if (path === '/consumed') {
          await request.text();
          throw new Error('private-error-secret');
        }
        if (path === '/locked') {
          const body = request.body;
          check(body, 'POST body required');
          body.getReader();
          throw new Error('private-error-secret');
        }
        if (path === '/background') {
          edge.waitUntil(
            (async () => {
              await edge.env.HOST.fetch('https://host/background-gate');
              check(getEdgeContext<Bindings>(request) === edge, 'background context identity');
              await edge.env.HOST.fetch('https://host/background-done');
            })()
          );
          return new Response('scheduled');
        }
        if (path === '/stream') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                await edge.env.HOST.fetch('https://host/stream-gate');
                check(getEdgeContext<Bindings>(request) === edge, 'stream context identity');
                controller.enqueue(new TextEncoder().encode(edge.env.MARKER));
                controller.close();
              },
            })
          );
        }
        return Response.json({ path, marker: edge.env.MARKER });
      })();
    },
  },
  {
    async beforeFetch(request, env) {
      const edge = getEdgeContext<Bindings>(request);
      check(edge?.env === env, 'hook binding identity');
      if (new URL(request.url).pathname.startsWith('/concurrent/')) {
        await edge.env.HOST.fetch('https://host/before-gate');
        check(getEdgeContext<Bindings>(request) === edge, 'context after concurrent async hook');
      }
    },
  }
);
