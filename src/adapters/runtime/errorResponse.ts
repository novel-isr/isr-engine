/** Keep runtime exceptions in platform logs rather than sending their contents to clients. */
export function createEdgeErrorResponse(platform: string, error: unknown): Response {
  console.error(`[isr:${platform}] request failed`, error);
  return new Response('Internal Server Error', {
    status: 500,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
