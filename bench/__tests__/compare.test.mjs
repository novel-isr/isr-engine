import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const comparePath = path.resolve(import.meta.dirname, '../compare.mjs');

describe('bench/compare.mjs', () => {
  it('skips regression comparison when the committed baseline uses a different bench protocol', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(
      dir,
      'baseline.json',
      [row({ path: '/', connections: 10, qps: 20_000, p95: 1 })],
      { duration_s: 8, tiers: [10, 100, 1000, 10000] }
    );
    const currentPath = writeBench(
      dir,
      'current.json',
      [row({ path: '/', connections: 10, qps: 2_000, p95: 4 })],
      { duration_s: 15, tiers: [10, 100, 1000] }
    );

    const output = execFileSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(output).toContain('baseline protocol is incompatible');
    expect(output).toContain('duration_s: baseline=8 current=15');
    expect(output).toContain('tiers: baseline=[10,100,1000,10000] current=[10,100,1000]');
  });

  it('skips regression comparison when the committed baseline is unhealthy', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 10, qps: 20_000, p95: 1, non2xxRate: 90 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 10, qps: 2_000, p95: 4 }),
    ]);

    const output = execFileSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(output).toContain('baseline is unhealthy');
    expect(output).toContain('current result passed configured health gates');
  });

  it('fails immediately when the current result has non-2xx responses', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 10, qps: 2_000, p95: 4 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 10, qps: 20_000, p95: 1, non2xxRate: 20 }),
    ]);

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('current bench result is unhealthy');
  });

  it('treats autocannon errors as an explicit optional budget', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 1000, qps: 2_000, p95: 4 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 1000, qps: 2_100, p95: 4, errors: 3 }),
    ]);

    const defaultOutput = execFileSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    expect(defaultOutput).toContain('no regressions detected');

    const strictResult = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
      env: { ...process.env, BENCH_MAX_ERRORS: '0' },
    });
    expect(strictResult.status).toBe(1);
    expect(strictResult.stderr).toContain('errors+timeouts=3');
  });

  it('does not produce Infinity when baseline p95 is zero', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/about', connections: 10, qps: 2_000, p95: 0 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/about', connections: 10, qps: 2_100, p95: 2 }),
    ]);

    const output = execFileSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(output).toContain('n/a');
    expect(output).not.toContain('Infinity');
  });

  it('ignores p95 percentage noise below the absolute millisecond budget', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 10, qps: 10_000, p95: 1 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 10, qps: 10_100, p95: 2 }),
    ]);

    const output = execFileSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(output).toContain('no regressions detected');
  });

  it('fails p95 only when relative and absolute budgets are both exceeded', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/about', connections: 1000, qps: 5_000, p95: 100 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/about', connections: 1000, qps: 5_100, p95: 180 }),
    ]);

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P95 +80.0% / +80.0ms');
  });
});

function writeBench(dir, filename, results, meta = {}) {
  const file = path.join(dir, filename);
  writeFileSync(
    file,
    JSON.stringify({
      meta: {
        timestamp: '2026-05-04T00:00:00.000Z',
        duration_s: 15,
        tiers: [10, 100, 1000],
        paths: ['/', '/about', '/books/1'],
        pipelining: 1,
        warmup_s: 3,
        cooldown_ms: 2000,
        node: 'v22.21.1',
        ...meta,
      },
      results,
    })
  );
  return file;
}

function row({ path, connections, qps, p95, non2xxRate = 0, errors = 0, timeouts = 0 }) {
  return {
    path,
    connections,
    requests_per_sec: qps,
    latency_p95_ms: p95,
    non_2xx_rate: non2xxRate,
    errors,
    timeouts,
  };
}
