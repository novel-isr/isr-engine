import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const stopper = new URL('../stop-app.mjs', import.meta.url).pathname;
async function app(stubborn = false) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const net = require('node:net');
    ${stubborn ? "process.on('SIGTERM', () => {});" : ''}
    const server = net.createServer(socket => socket.end());
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup deadline')), 3000);
    child.stdout.once('data', data => {
      clearTimeout(timer);
      resolve(Number(data.toString().trim()));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`fixture exited ${code}`));
    });
  });
  return { child, port };
}
async function stop(pid, port) {
  const child = spawn(process.execPath, [stopper, String(pid), String(port)], {
    env: { ...process.env, BENCH_STOP_GRACE_MS: '150', BENCH_STOP_FORCE_MS: '1000' },
  });
  let output = '';
  child.stderr.on('data', data => {
    output += data;
  });
  const [status] = await once(child, 'exit');
  return { status, output };
}
function cleanup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
describe('bench process shutdown', () => {
  it.each([false, true])(
    'confirms the process group and listener stop (ignore TERM=%s)',
    async stubborn => {
      const fixture = await app(stubborn);
      try {
        expect((await stop(fixture.child.pid, fixture.port)).status).toBe(0);
        expect(() => process.kill(fixture.child.pid, 0)).toThrow();
      } finally {
        cleanup(fixture.child);
      }
    }
  );
  it('fails when another process keeps the benchmark port occupied', async () => {
    const target = await app();
    const occupant = await app();
    try {
      const result = await stop(target.child.pid, occupant.port);
      expect(result.status).toBe(1);
      expect(result.output).toContain('listener still active');
    } finally {
      cleanup(target.child);
      cleanup(occupant.child);
    }
  });
});
