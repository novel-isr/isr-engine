// CI-only preload. Observe the Node HTTP boundary without changing engine code,
// request handling, timeouts, or benchmark acceptance criteria.
import { subscribe } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const output = process.env.BENCH_SERVER_DIAGNOSTICS;
if (output) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const started = performance.now();
  const servers = new WeakSet();
  const sockets = new Map();
  const samples = [];
  let accepted = 0;
  let requests = 0;
  let finished = 0;
  let aborted = 0;
  subscribe('http.server.request.start', ({ server, socket, response }) => {
    if (!servers.has(server)) {
      servers.add(server);
      server.on('connection', connection => {
        accepted++;
        sockets.set(connection, {
          port: connection.remotePort,
          acceptedAt: performance.now(),
          requests: 0,
          finished: 0,
        });
        connection.once('close', () => sockets.delete(connection));
      });
    }
    requests++;
    const state = sockets.get(socket);
    if (state) {
      state.requests++;
      state.lastRequestAt = performance.now();
    }
    response.once('finish', () => {
      finished++;
      if (state) {
        state.finished++;
        state.lastFinishAt = performance.now();
      }
    });
    response.once('close', () => {
      if (!response.writableFinished) aborted++;
    });
  });
  const interval = setInterval(() => {
    const now = performance.now();
    samples.push({
      elapsed_ms: now - started,
      accepted,
      active: sockets.size,
      requests,
      finished,
      aborted,
      resource_usage: process.resourceUsage(),
      event_loop_utilization: performance.eventLoopUtilization().utilization,
      event_loop_delay_max_ms: delay.max / 1e6,
      stalled: [...sockets]
        .filter(
          ([, state]) =>
            (state.requests === 0 || state.requests > state.finished) &&
            now - (state.lastRequestAt ?? state.acceptedAt) > 2000
        )
        .slice(0, 20)
        .map(([socket, state]) => ({
          ...state,
          bytesRead: socket.bytesRead,
          bytesWritten: socket.bytesWritten,
          writableLength: socket.writableLength,
        })),
    });
    if (samples.length > 600) samples.shift();
  }, 1000);
  interval.unref();
  const flush = () => {
    writeFileSync(output, JSON.stringify({ accepted, requests, finished, aborted, samples }));
  };
  // Preserve evidence even if the engine cannot drain before CI's forced kill.
  process.once('SIGTERM', flush);
  process.once('exit', () => {
    clearInterval(interval);
    flush();
  });
}
