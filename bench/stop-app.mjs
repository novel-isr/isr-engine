#!/usr/bin/env node
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const pid = Number(process.argv[2]);
const port = Number(process.argv[3]);
const graceMs = Number(process.env.BENCH_STOP_GRACE_MS ?? '5000');
const forceMs = Number(process.env.BENCH_STOP_FORCE_MS ?? '5000');
if (
  !Number.isInteger(pid) ||
  pid <= 1 ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  ![graceMs, forceMs].every(n => Number.isFinite(n) && n >= 0)
) {
  console.error('usage: stop-app.mjs <isolated-process-group-pid> <port>');
  process.exit(2);
}
function signalGroup(signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function listenerActive() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.setTimeout(150, () => finish(true));
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      // A reset can race shutdown; only a refused connection proves the port is closed.
      else if (error.code === 'ECONNRESET') resolve(true);
      else reject(error);
    });
  });
}
async function waitStopped(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const groupAlive = signalGroup(0);
    const listening = await listenerActive();
    if (!groupAlive && !listening) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, deadline - Date.now()));
  } while (Date.now() < deadline);
  return false;
}
try {
  signalGroup('SIGTERM');
  if (!(await waitStopped(graceMs))) {
    signalGroup('SIGKILL');
    if (!(await waitStopped(forceMs)))
      throw new Error(
        `process group or listener still active after forced shutdown (pid=${pid}, port=${port})`
      );
  }
  console.log(
    `confirmed benchmark process group exited and listener stopped (pid=${pid}, port=${port})`
  );
} catch (error) {
  console.error(`benchmark shutdown failed: ${error.message}`);
  process.exitCode = 1;
}
