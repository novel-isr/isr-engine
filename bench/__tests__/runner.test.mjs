import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runner = new URL('../runner.mjs', import.meta.url).pathname;
function run(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runner], { env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      output += data;
    });
    child.on('close', status => resolve({ status, output }));
  });
}
describe('bench runner health gates', () => {
  it('rejects an empty tier list before contacting the target', async () => {
    const result = await run({ BENCH_TIERS: 'invalid', BENCH_URL: 'http://127.0.0.1:1' });
    expect(result.status).toBe(2);
    expect(result.output).toContain('invalid benchmark configuration');
  });
  it('rejects sustained regeneration runs too short to cross the configured TTL', async () => {
    const result = await run({ BENCH_SCENARIO: 'regeneration', BENCH_DURATION: '8' });
    expect(result.status).toBe(2);
    expect(result.output).toContain('regeneration requires at least 65 seconds');
  });
});
