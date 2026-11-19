import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const comparePath = path.resolve(import.meta.dirname, '../compare.mjs');

describe('bench/compare.mjs', () => {
  it('rejects regression comparison when the committed baseline uses a different bench protocol', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(
      dir,
      'baseline.json',
      [10, 100, 1000, 10000].map(connections =>
        row({ path: '/', connections, qps: 20_000, p95: 1 })
      ),
      { duration_s: 8, tiers: [10, 100, 1000, 10000] }
    );
    const currentPath = writeBench(
      dir,
      'current.json',
      [10, 100, 1000].map(connections => row({ path: '/', connections, qps: 2_000, p95: 4 })),
      { duration_s: 15, tiers: [10, 100, 1000] }
    );

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);

    expect(output).toContain('baseline protocol is incompatible');
    expect(output).toContain('duration_s: baseline=8 current=15');
    expect(output).toContain('tiers: baseline=[10,100,1000,10000] current=[10,100,1000]');
  });

  it('rejects regression comparison when the committed baseline lacks runner metadata', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(
      dir,
      'baseline.json',
      [row({ path: '/', connections: 10, qps: 20_000, p95: 1 })],
      { bench_protocol: undefined, runner_id: undefined }
    );
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 10, qps: 2_000, p95: 4 }),
    ]);

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);

    expect(output).toContain('baseline protocol is incompatible');
    expect(output).toContain('bench_protocol: baseline=<missing> current=4');
    expect(output).toContain('runner_id: baseline=<missing> current=unit-runner');
  });

  it('rejects regression comparison when runner classes differ', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(
      dir,
      'baseline.json',
      [row({ path: '/', connections: 10, qps: 20_000, p95: 1 })],
      { runner_id: 'local-mac' }
    );
    const currentPath = writeBench(
      dir,
      'current.json',
      [row({ path: '/', connections: 10, qps: 2_000, p95: 4 })],
      { runner_id: 'github-actions-ubuntu-latest-x64-node22' }
    );

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);

    expect(output).toContain('runner_id: baseline=local-mac current=github-actions');
  });

  it('rejects regression comparison when the committed baseline is unhealthy', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 10, qps: 20_000, p95: 1, non2xxRate: 90 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 10, qps: 2_000, p95: 4 }),
    ]);

    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);

    expect(output).toContain('baseline is unhealthy');
    expect(output).toContain('baseline is unhealthy');
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

  it('rejects benchmark errors by default and accepts an explicit budget', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 1000, qps: 2_000, p95: 4 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 1000, qps: 2_100, p95: 4, errors: 3 }),
    ]);

    const defaultResult = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
    });
    expect(defaultResult.status).toBe(1);
    const allowed = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
      env: { ...process.env, BENCH_MAX_ERRORS: '3' },
    });
    expect(allowed.status).toBe(0);

    const strictResult = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
      env: { ...process.env, BENCH_MAX_ERRORS: '0' },
    });
    expect(strictResult.status).toBe(1);
    expect(strictResult.stderr).toContain('errors=3 (timeouts=0)');
  });

  it('counts timeouts as a subset of total errors rather than adding them twice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const baselinePath = writeBench(dir, 'baseline.json', [
      row({ path: '/', connections: 1000, qps: 2_000, p95: 4 }),
    ]);
    const currentPath = writeBench(dir, 'current.json', [
      row({ path: '/', connections: 1000, qps: 2_100, p95: 4, errors: 3, timeouts: 3 }),
    ]);
    const result = spawnSync(process.execPath, [comparePath, baselinePath, currentPath], {
      encoding: 'utf8',
      env: { ...process.env, BENCH_MAX_ERRORS: '3' },
    });
    expect(result.status).toBe(0);
    const inconsistentPath = writeBench(dir, 'inconsistent.json', [
      row({ path: '/', connections: 1000, qps: 2_100, p95: 4, errors: 2, timeouts: 3 }),
    ]);
    const inconsistent = spawnSync(
      process.execPath,
      [comparePath, baselinePath, inconsistentPath],
      {
        encoding: 'utf8',
        env: { ...process.env, BENCH_MAX_ERRORS: '3' },
      }
    );
    expect(inconsistent.status).toBe(1);
    expect(inconsistent.stderr).toContain('timeouts exceed total errors');
  });

  it.each([
    'missing',
    'empty',
    'duplicate',
    'missing-tier',
    'invalid-budget',
    'invalid-counter',
    'missing-counter',
    'body-mismatch',
    'incomplete-matrix',
  ])('fails closed for %s input', kind => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const healthy = row({ path: '/', connections: 10, qps: 2000, p95: 4 });
    const baseline = writeBench(dir, 'baseline.json', [healthy]);
    const rows =
      kind === 'empty'
        ? []
        : kind === 'duplicate'
          ? [healthy, healthy]
          : kind === 'missing-tier'
            ? [{ ...healthy, connections: 100 }]
            : kind === 'invalid-counter'
              ? [{ ...healthy, errors: 'broken' }]
              : kind === 'missing-counter'
                ? [{ ...healthy, errors: undefined }]
                : kind === 'body-mismatch'
                  ? [{ ...healthy, body_mismatches: 1 }]
                  : [healthy];
    const current = writeBench(
      dir,
      'current.json',
      rows,
      kind === 'incomplete-matrix' ? { tiers: [10, 100] } : {}
    );
    const result = spawnSync(
      process.execPath,
      [comparePath, kind === 'missing' ? baseline + '.absent' : baseline, current],
      {
        encoding: 'utf8',
        env: { ...process.env, ...(kind === 'invalid-budget' ? { BENCH_MAX_ERRORS: 'NaN' } : {}) },
      }
    );
    expect(result.status).not.toBe(0);
  });

  it('rejects matching reports when both omit a declared tier', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const rows = [row({ path: '/', connections: 10, qps: 2000, p95: 4 })];
    const base = writeBench(dir, 'base.json', rows, { tiers: [10, 100] });
    const current = writeBench(dir, 'current.json', rows, { tiers: [10, 100] });
    expect(spawnSync(process.execPath, [comparePath, base, current]).status).toBe(1);
  });

  it('rejects matching legacy reports without current semantic health evidence', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const rows = [row({ path: '/', connections: 10, qps: 2000, p95: 4 })];
    const base = writeBench(dir, 'base.json', rows, { bench_protocol: 2 });
    const current = writeBench(dir, 'current.json', rows, { bench_protocol: 2 });
    expect(spawnSync(process.execPath, [comparePath, base, current]).status).toBe(1);
  });

  it.each([
    undefined,
    { primed_connections: 9, setup_ms: 1 },
    { primed_connections: 10, setup_ms: -1 },
    { primed_connections: 10, setup_ms: 10001 },
  ])('rejects throughput recorded without a fully verified connection pool: %j', startup => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const valid = row({ path: '/', connections: 10, qps: 2000, p95: 4 });
    const base = writeBench(dir, 'base.json', [valid]);
    const current = writeBench(dir, 'current.json', [{ ...valid, startup }]);
    const result = spawnSync(process.execPath, [comparePath, base, current], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('connection pool was not fully verified');
  });

  it.each([
    { node: 'v22.21.1' },
    { load_generator: 'autocannon' },
    { connection_setup: 'unverified-tcp-connect' },
    { request_timeout_ms: 20000 },
    { setup_timeout_ms: 20000 },
  ])('rejects matching reports that violate protocol 4: %j', meta => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    const rows = [row({ path: '/', connections: 10, qps: 2000, p95: 4 })];
    const base = writeBench(dir, 'base.json', rows, meta);
    const current = writeBench(dir, 'current.json', rows, meta);
    const result = spawnSync(process.execPath, [comparePath, base, current], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('protocol 4 requires Node 24.15.0');
  });

  it.each([undefined, { connected_at_start: 10, connected_at_end: 9 }])(
    'rejects a report missing its verified connection pool at cleanup: %j',
    pool => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
      const valid = row({ path: '/', connections: 10, qps: 2000, p95: 4 });
      const base = writeBench(dir, 'base.json', [valid]);
      const current = writeBench(dir, 'current.json', [{ ...valid, pool }]);
      const result = spawnSync(process.execPath, [comparePath, base, current], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('verified connection pool was lost');
    }
  );

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
        bench_protocol: 4,
        load_generator: 'undici',
        connection_setup: 'verified-response-barrier',
        request_timeout_ms: 10000,
        setup_timeout_ms: 10000,
        runner_id: 'unit-runner',
        scenario: 'warm',
        duration_s: 15,
        tiers: [...new Set(results.map(r => r.connections))],
        paths: [...new Set(results.map(r => r.path))],
        pipelining: 1,
        warmup_s: 3,
        cooldown_ms: 2000,
        node: 'v24.15.0',
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
    requests_total: Math.round(qps * 15),
    latency_p95_ms: p95,
    non_2xx_rate: non2xxRate,
    body_mismatches: 0,
    startup: { primed_connections: connections, setup_ms: 1 },
    pool: { connected_at_start: connections, connected_at_end: connections },
    errors,
    timeouts,
  };
}
