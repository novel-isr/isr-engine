import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function kernelSnapshot() {
  const read = path => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  };
  return {
    somaxconn: read('/proc/sys/net/core/somaxconn'),
    tcp_max_syn_backlog: read('/proc/sys/net/ipv4/tcp_max_syn_backlog'),
    netstat: read('/proc/net/netstat'),
    sockstat: read('/proc/net/sockstat'),
    limits: read('/proc/self/limits'),
  };
}

// Autocannon reconnects BEFORE emitting timeout. Retain the previous socket so
// evidence describes the timed-out connection rather than its replacement.
export function createLoadDiagnostics() {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const utilization = performance.eventLoopUtilization();
  const kernelBefore = kernelSnapshot();
  const timeouts = [];
  const connectionErrors = {};
  let connections = 0;
  let connected = 0;
  let completed = 0;
  return {
    setupClient(client) {
      let current;
      let previous;
      client.on('request', () => {
        if (current?.socket === client.conn) return;
        previous = current;
        const state = { socket: client.conn, started: performance.now(), responses: 0 };
        current = state;
        connections++;
        state.socket.once('connect', () => {
          state.connectedAt = performance.now();
          state.localPort = state.socket.localPort;
          connected++;
        });
        state.socket.once('data', () => {
          state.firstByteAt = performance.now();
        });
      });
      client.on('response', () => {
        current.responses++;
        current.lastResponseAt = performance.now();
        completed++;
      });
      client.on('connError', error => {
        const key = error.code ?? error.message;
        connectionErrors[key] = (connectionErrors[key] ?? 0) + 1;
      });
      client.on('timeout', () => {
        if (!previous || timeouts.length >= 20) return;
        const { socket, ...state } = previous;
        timeouts.push({
          ...state,
          elapsed_ms: performance.now() - state.started,
          connecting: socket.connecting,
          bytesRead: socket.bytesRead,
          bytesWritten: socket.bytesWritten,
          writableLength: socket.writableLength,
          destroyed: socket.destroyed,
        });
      });
    },
    finish() {
      delay.disable();
      return {
        connections,
        connected,
        completed,
        connection_errors: connectionErrors,
        timeout_samples: timeouts,
        event_loop_utilization: performance.eventLoopUtilization(utilization).utilization,
        event_loop_delay_max_ms: delay.max / 1e6,
        kernel_before: kernelBefore,
        kernel_after: kernelSnapshot(),
      };
    },
  };
}
