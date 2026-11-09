import { expect, it } from 'vitest';
import express from 'express';
import { request } from 'node:http';
import {
  nodeToWebRequest,
  createProductionRequestHandler,
  createProductionJsonMiddleware,
} from '../productionRuntime';

async function serve(app: ReturnType<typeof express>, check: (url: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    await check(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it('uses only explicitly trusted proxy protocol and validates the selected chain token', async () => {
  for (const trust of [false, 'loopback', '192.0.2.0/24', 1]) {
    const app = express();
    app.set('trust proxy', trust);
    app.get('/', (req, res) => res.send(nodeToWebRequest(req).url));
    await serve(app, async url => {
      for (const forwarded of [
        'https, http',
        '  https , http',
        'HTTPS, HTTP',
        'javascript, https',
      ]) {
        const response = await fetch(url, {
          headers: { 'x-forwarded-proto': forwarded, 'x-forwarded-host': 'spoof.invalid' },
        });
        expect(response.status).toBe(200);
        const protocol =
          (trust === 'loopback' || trust === 1) && !forwarded.startsWith('javascript')
            ? 'https:'
            : 'http:';
        expect(await response.text()).toBe(url.replace('http:', protocol) + '/');
      }
    });
  }
});

it('aborts a slow Fetch handler when the client disconnects before response headers', async () => {
  const app = express();
  const errors: unknown[] = [];
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  let observed!: () => void;
  const aborted = new Promise<void>(resolve => {
    observed = resolve;
  });
  app.use(
    createProductionRequestHandler(
      async req => {
        started();
        await new Promise<void>(resolve =>
          req.signal.addEventListener(
            'abort',
            () => {
              observed();
              resolve();
            },
            { once: true }
          )
        );
        throw req.signal.reason;
      },
      error => {
        errors.push(error);
      }
    )
  );
  await serve(app, async url => {
    const client = request(url);
    client.on('error', () => {});
    client.end();
    await ready;
    client.destroy();
    await expect(
      Promise.race([
        aborted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('handler stayed alive')), 500)
        ),
      ])
    ).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(errors).toEqual([]);
  });
});

it('does not abort a completed GET or parsed POST, including deferred handler work', async () => {
  const app = express();
  const signals: AbortSignal[] = [];
  app.use(createProductionJsonMiddleware());
  app.use(
    createProductionRequestHandler(
      async req => {
        signals.push(req.signal);
        await new Promise(resolve => setTimeout(resolve, 10));
        return new Response('done');
      },
      error => {
        throw error;
      }
    )
  );
  await serve(app, async url => {
    for (const method of ['GET', 'POST']) {
      expect(
        await (
          await fetch(url, {
            method,
            ...(method === 'POST'
              ? { headers: { 'content-type': 'application/json' }, body: '{}' }
              : {}),
          })
        ).text()
      ).toBe('done');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
  });
});

it('cancels a response returned after disconnect and removes lifecycle listeners', async () => {
  const app = express();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => {
    cancelled = resolve;
  });
  let incoming!: express.Request;
  let outgoing!: express.Response;
  let baseline!: number[];
  app.use((req, res, next) => {
    incoming = req;
    outgoing = res;
    baseline = [
      req.listenerCount('aborted'),
      res.listenerCount('close'),
      res.listenerCount('finish'),
    ];
    next();
  });
  app.use(
    createProductionRequestHandler(
      async () => {
        entered();
        await gate;
        return new Response(new ReadableStream({ cancel: cancelled }));
      },
      error => {
        throw error;
      }
    )
  );
  await serve(app, async url => {
    const client = request(url);
    client.on('error', () => {});
    client.end();
    await ready;
    client.destroy();
    // Wait for the server socket to observe disconnect before releasing the handler.
    await new Promise<void>(resolve => outgoing.once('close', resolve));
    release();
    await cancellation;
    expect(incoming.listenerCount('aborted')).toBe(baseline[0]);
    expect(outgoing.listenerCount('close')).toBeLessThanOrEqual(baseline[1]);
    expect(outgoing.listenerCount('finish')).toBeLessThanOrEqual(baseline[2]);
  });
});

it('aborts the Request and cancels its streamed response after headers were sent', async () => {
  const app = express();
  let signal!: AbortSignal;
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => {
    cancelled = resolve;
  });
  const errors: unknown[] = [];
  app.use(
    createProductionRequestHandler(
      async req => {
        signal = req.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first chunk'));
            },
            cancel: cancelled,
          })
        );
      },
      error => {
        errors.push(error);
      }
    )
  );
  await serve(app, async url => {
    const client = request(url);
    client.on('error', () => {});
    client.end();
    await new Promise<void>(resolve =>
      client.once('response', response => {
        response.once('data', () => {
          client.destroy();
          resolve();
        });
      })
    );
    await cancellation;
    expect(signal.aborted).toBe(true);
    expect(errors).toEqual([]);
  });
});

it('falls back to the socket transport for native requests without Express getters', () => {
  const native = {
    headers: { host: 'example.com', 'x-forwarded-proto': 'https, http' },
    url: '/',
    method: 'GET',
    socket: {},
  };
  expect(nodeToWebRequest(native as unknown as express.Request).url).toBe('http://example.com/');
  expect(
    nodeToWebRequest({ ...native, socket: { encrypted: true } } as unknown as express.Request).url
  ).toBe('https://example.com/');
});

it('settles the disconnected handler without waiting for a late response cancel hook', async () => {
  const app = express();
  let releaseHandler!: (response: Response) => void;
  const responseGate = new Promise<Response>(resolve => {
    releaseHandler = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  let cancellationStarted!: () => void;
  const cancelling = new Promise<void>(resolve => {
    cancellationStarted = resolve;
  });
  let rejectCancellation!: (reason: Error) => void;
  const cancelGate = new Promise<void>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const errors: unknown[] = [];
  const bridge = createProductionRequestHandler(
    async () => {
      entered();
      return responseGate;
    },
    error => {
      errors.push(error);
    }
  );
  let settled = false;
  let outgoing!: express.Response;
  app.use((req, res, next) => {
    outgoing = res;
    Promise.resolve(bridge(req, res, next)).then(() => {
      settled = true;
    });
  });
  await serve(app, async url => {
    const client = request(url);
    client.on('error', () => {});
    client.end();
    await ready;
    const closed = new Promise<void>(resolve => outgoing.once('close', resolve));
    client.destroy();
    await closed;
    releaseHandler(
      new Response(
        new ReadableStream({
          cancel() {
            cancellationStarted();
            return cancelGate;
          },
        })
      )
    );
    await cancelling;
    // One event-loop turn drains the handler's microtasks; cancellation remains pending.
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(settled).toBe(true);
      expect(outgoing.listenerCount('close')).toBe(0);
    } finally {
      rejectCancellation(new Error('late upstream cancellation failure'));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(errors).toEqual([]);
  });
});
