import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Client } from 'undici';
import { kernelSnapshot } from './diagnostics.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const SAMPLE_LIMIT = 20;

/**
 * Protocol 4: prime one verified HTTP response on every physical connection,
 * then measure closed loops on that same connected pool. Throughput counts
 * response body bytes, and latency is a native nanosecond histogram.
 *
 * Startup failures reject with their partial metrics on error.result. Timed
 * request/transport/semantic failures remain in the returned health counters;
 * callers must reject any nonzero errors, non2xx or mismatches.
 */
export async function measureHttp({
  url,
  connections,
  duration,
  pipelining = 1,
  headers = {},
  verifyBody,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  setupTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const target = new URL(url);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !Number.isInteger(connections) ||
    connections < 1 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isInteger(pipelining) ||
    pipelining < 1 ||
    typeof verifyBody !== 'function' ||
    ![requestTimeoutMs, setupTimeoutMs].every(value => Number.isFinite(value) && value > 0)
  ) {
    throw new TypeError('Invalid HTTP benchmark configuration');
  }

  const setupStarted = performance.now();
  const setupDeadline = setupStarted + setupTimeoutMs;
  const setupController = new AbortController();
  const setupTimeout = Object.assign(new Error('HTTP benchmark setup deadline exceeded'), {
    code: 'BENCH_SETUP_TIMEOUT',
  });
  const setupTimer = setTimeout(() => setupController.abort(setupTimeout), setupTimeoutMs);
  const histogram = createHistogram();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const utilization = performance.eventLoopUtilization();
  const kernelBefore = kernelSnapshot();
  const states = [];
  const connectionSamples = [];
  const requestErrors = [];
  let phase = 'setup';
  let primedConnections = 0;
  let setupMs = 0;
  let opened = 0;
  let connectedAtBarrier = 0;
  let connectedAtEnd = 0;
  let completed = 0;
  let healthResponses = 0;
  let bodyBytes = 0;
  let errors = 0;
  let timeouts = 0;
  let mismatches = 0;
  let non2xx = 0;
  let measuredStart;
  let measuredEnd;
  let failure;
  let lastHealthError;
  let priming = [];

  const currentPhase = () =>
    phase === 'measure' && process.hrtime.bigint() >= measuredEnd ? 'drain' : phase;

  function sampleConnection(event, state, error) {
    if (phase === 'cleanup') return;
    if (connectionSamples.length === SAMPLE_LIMIT) connectionSamples.shift();
    connectionSamples.push({
      event,
      client: state.index,
      phase: currentPhase(),
      elapsed_ms: performance.now() - setupStarted,
      code: error?.code,
      message: error?.message,
    });
  }

  function recordError(error, state, timedOut = false) {
    lastHealthError = error;
    errors++;
    if (timedOut) timeouts++;
    if (requestErrors.length < SAMPLE_LIMIT) {
      requestErrors.push({
        client: state?.index,
        phase: currentPhase(),
        code: error.code,
        message: error.message,
        timeout: timedOut,
      });
    }
  }

  async function request(state, initial) {
    const started = process.hrtime.bigint();
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error('HTTP benchmark request timed out'), {
      code: 'BENCH_REQUEST_TIMEOUT',
    });
    const timer = setTimeout(() => controller.abort(timeoutError), requestTimeoutMs);
    const signal = initial
      ? AbortSignal.any([controller.signal, setupController.signal])
      : controller.signal;
    try {
      const response = await state.client.request({
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        signal,
        blocking: false,
        headersTimeout: requestTimeoutMs,
        bodyTimeout: requestTimeoutMs,
      });
      const body = Buffer.from(await response.body.arrayBuffer());
      healthResponses++;
      const finished = process.hrtime.bigint();
      if (Number(finished - started) / 1e6 >= requestTimeoutMs) throw timeoutError;
      // Requests finishing after the window are still fully verified below.
      if (!initial && finished < measuredEnd) {
        completed++;
        bodyBytes += body.byteLength;
        histogram.record(finished > started ? finished - started : 1n);
      }
      const badStatus = response.statusCode < 200 || response.statusCode >= 300;
      if (badStatus) non2xx++;
      const badBody = verifyBody(body) !== true;
      if (badBody) mismatches++;
      if (badStatus || badBody) {
        throw Object.assign(
          new Error(
            `HTTP benchmark ${initial ? 'priming' : 'request'} failed: ` +
              `status=${response.statusCode}, body_match=${!badBody}`
          ),
          { code: 'BENCH_RESPONSE_INVALID' }
        );
      }
      if (
        initial &&
        String(response.headers.connection ?? '')
          .toLowerCase()
          .split(',')
          .some(value => value.trim() === 'close')
      ) {
        throw Object.assign(new Error('Priming response closed its connection'), {
          code: 'BENCH_PRIMING_DISCONNECTED',
        });
      }
      if (initial) primedConnections++;
      return true;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const timedOut =
        controller.signal.aborted ||
        (initial && setupController.signal.reason === setupTimeout) ||
        [
          'BENCH_REQUEST_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
          'UND_ERR_CONNECT_TIMEOUT',
        ].includes(error.code);
      recordError(error, state, timedOut);
      if (initial) throw error;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    for (let index = 0; index < connections; index++) {
      const client = new Client(target.origin, {
        pipelining,
        connectTimeout: requestTimeoutMs,
        headersTimeout: requestTimeoutMs,
        bodyTimeout: requestTimeoutMs,
        allowH2: false,
      });
      const state = { index, client, connected: false, lostConnection: false, opened: 0 };
      states.push(state);
      client.on('connect', () => {
        state.connected = true;
        opened++;
        state.opened++;
        sampleConnection('connect', state);
        if (state.opened > 1 && phase !== 'cleanup' && !state.lostConnection) {
          recordError(
            Object.assign(new Error('Benchmark connection was replaced'), {
              code: 'BENCH_POOL_RECONNECTED',
            }),
            state
          );
        }
        state.lostConnection = false;
      });
      client.on('disconnect', (_origin, _targets, error) => {
        state.connected = false;
        sampleConnection('disconnect', state, error);
        if (phase !== 'cleanup') {
          state.lostConnection = true;
          recordError(
            Object.assign(new Error('Benchmark connection disconnected before cleanup'), {
              code: 'BENCH_POOL_DISCONNECTED',
              cause: error,
            }),
            state
          );
        }
      });
      client.on('connectionError', (_origin, _targets, error) => {
        sampleConnection('connectionError', state, error);
        recordError(error, state, error.code === 'UND_ERR_CONNECT_TIMEOUT');
      });
    }

    // No client may enter its request loop until every first response verifies.
    priming = states.map(state => request(state, true));
    await Promise.all(priming);
    if (
      performance.now() >= setupDeadline ||
      setupController.signal.aborted ||
      errors > 0 ||
      states.some(state => !state.connected || !state.client.stats.connected)
    ) {
      const error =
        performance.now() >= setupDeadline
          ? setupTimeout
          : (setupController.signal.reason ??
            lastHealthError ??
            new Error('Primed pool is disconnected'));
      recordError(error, undefined, error === setupTimeout);
      throw error;
    }
    clearTimeout(setupTimer);
    setupMs = performance.now() - setupStarted;
    connectedAtBarrier = states.length;
    phase = 'measure';
    measuredStart = process.hrtime.bigint();
    measuredEnd = measuredStart + BigInt(Math.round(duration * 1e9));

    async function loop(state) {
      while (process.hrtime.bigint() < measuredEnd) {
        if (!(await request(state, false))) return;
      }
    }
    // Each Client owns exactly one physical connection. N loops keep at most
    // N requests outstanding on its documented HTTP/1.1 pipeline.
    await Promise.all(
      states.flatMap(state => Array.from({ length: pipelining }, () => loop(state)))
    );
  } catch (error) {
    if (phase === 'setup') setupMs = performance.now() - setupStarted;
    failure = error;
  } finally {
    clearTimeout(setupTimer);
    connectedAtEnd = states.filter(state => state.connected && state.client.stats.connected).length;
    phase = 'cleanup';
    setupController.abort(failure);
    const cleanup = await Promise.allSettled(
      states.map(state => Promise.resolve().then(() => state.client.destroy()))
    );
    // Observe every priming rejection even when an earlier one ended startup.
    await Promise.allSettled(priming);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        recordError(result.reason);
        failure ??= result.reason;
      }
    }
    loopDelay.disable();
  }

  const percentile = value => (histogram.count ? histogram.percentile(value) / 1e6 : 0);
  const result = {
    requests: { total: completed, average: completed / duration },
    throughput: { average: bodyBytes / duration },
    latency: {
      count: histogram.count,
      average: histogram.count ? histogram.mean / 1e6 : 0,
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p97_5: percentile(97.5),
      p99: percentile(99),
      max: histogram.count ? histogram.max / 1e6 : 0,
    },
    errors,
    timeouts,
    mismatches,
    non2xx,
    health_responses_total: healthResponses,
    startup: {
      primed_connections: primedConnections,
      setup_ms: setupMs || performance.now() - setupStarted,
    },
    diagnostics: {
      opened_connections: opened,
      connected: connectedAtBarrier,
      connected_after_measurement: connectedAtEnd,
      connection_samples: connectionSamples,
      request_errors: requestErrors,
      event_loop_utilization: performance.eventLoopUtilization(utilization).utilization,
      event_loop_delay_max_ms: loopDelay.max / 1e6,
      kernel_before: kernelBefore,
      kernel_after: kernelSnapshot(),
    },
  };
  if (failure) {
    failure.result = result;
    throw failure;
  }
  return result;
}
