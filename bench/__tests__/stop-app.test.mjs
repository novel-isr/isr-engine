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
async function stop(pid, port, probeErrors) {
  const imports = [];
  if (probeErrors) {
    // Replace only the TCP OS boundary in the stopper subprocess; the target group stays real.
    const preloader = `
      import net from 'node:net';
      import { EventEmitter } from 'node:events';
      const errors = ${JSON.stringify(probeErrors)};
      let probe = 0;
      net.createConnection = () => {
        const socket = new EventEmitter();
        socket.destroy = () => socket;
        socket.setTimeout = () => socket;
        queueMicrotask(() => {
          const code = errors[Math.min(probe++, errors.length - 1)];
          process.stderr.write('probe-error:' + code + '\\n');
          socket.emit('error', Object.assign(new Error(code + ' injected connection boundary'), { code }));
        });
        return socket;
      };
    `;
    imports.push('--import', `data:text/javascript,${encodeURIComponent(preloader)}`);
  }
  const child = spawn(process.execPath, [...imports, stopper, String(pid), String(port)], {
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
        const result = await stop(fixture.child.pid, fixture.port);
        expect(result.status, result.output).toBe(0);
        expect(() => process.kill(fixture.child.pid, 0)).toThrow();
      } finally {
        cleanup(fixture.child);
      }
    }
  );
  it('keeps polling after a reset and requires a later refused connection', async () => {
    const fixture = await app(true);
    try {
      const result = await stop(fixture.child.pid, fixture.port, ['ECONNRESET', 'ECONNREFUSED']);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('probe-error:ECONNRESET');
      expect(result.output).toContain('probe-error:ECONNREFUSED');
      expect(() => process.kill(fixture.child.pid, 0)).toThrow();
    } finally {
      cleanup(fixture.child);
    }
  });
  it('does not accept persistent resets as proof that the listener stopped', async () => {
    const fixture = await app(true);
    try {
      const result = await stop(fixture.child.pid, fixture.port, ['ECONNRESET']);
      expect(result.status).toBe(1);
      expect(result.output).toContain('listener still active');
    } finally {
      cleanup(fixture.child);
    }
  });
  it.each(['EPERM', 'EACCES'])('fails immediately on unexpected probe error %s', async code => {
    const fixture = await app(true);
    try {
      const result = await stop(fixture.child.pid, fixture.port, [code, 'ECONNREFUSED']);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`${code} injected connection boundary`);
      expect(result.output).not.toContain('probe-error:ECONNREFUSED');
    } finally {
      cleanup(fixture.child);
    }
  });
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
