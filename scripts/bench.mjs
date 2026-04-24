#!/usr/bin/env node
/**
 * 多档并发 HTTP 基准测试 —— 用 autocannon 验证 isr-engine 在不同负载下的表现
 *
 * 用法：
 *   pnpm bench                          # 默认本地 :3000，全档位
 *   BENCH_URL=https://x pnpm bench       # 指定目标
 *   BENCH_TIERS=100,1000 pnpm bench      # 指定并发档
 *   BENCH_DURATION=20 pnpm bench         # 每档持续秒数
 *   BENCH_PATHS=/,/books/1 pnpm bench    # 指定路径
 *   BENCH_OUTPUT=bench.json pnpm bench   # 写 JSON 结果（CI 比较用）
 *
 * 退出码：
 *   0 全部 P95 < BENCH_P95_BUDGET_MS（默认不开预算检查）
 *   1 任意档 P95 超出预算（用于 CI gate）
 */
import autocannon from 'autocannon';
import { writeFileSync } from 'node:fs';

const URL = process.env.BENCH_URL ?? 'http://localhost:3000';
const TIERS = (process.env.BENCH_TIERS ?? '10,100,1000,10000')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n) && n > 0);
const DURATION = parseInt(process.env.BENCH_DURATION ?? '15', 10);
const PATHS = (process.env.BENCH_PATHS ?? '/,/books/1,/about').split(',').map(s => s.trim());
const OUTPUT = process.env.BENCH_OUTPUT;
const P95_BUDGET = process.env.BENCH_P95_BUDGET_MS
  ? parseInt(process.env.BENCH_P95_BUDGET_MS, 10)
  : null;
const PIPELINING = parseInt(process.env.BENCH_PIPELINING ?? '1', 10);

console.log(`\n=== isr-engine bench ===`);
console.log(`target:      ${URL}`);
console.log(`tiers:       ${TIERS.join(', ')} concurrent connections`);
console.log(`duration:    ${DURATION}s per tier`);
console.log(`paths:       ${PATHS.join(', ')}`);
console.log(`pipelining:  ${PIPELINING}`);
if (P95_BUDGET) console.log(`p95 budget:  ${P95_BUDGET}ms (CI gate active)\n`);
else console.log(`p95 budget:  none (informational)\n`);

const results = [];

for (const path of PATHS) {
  for (const conns of TIERS) {
    const target = `${URL}${path}`;
    process.stdout.write(`▶ ${target}  conns=${conns}  ... `);
    const t0 = Date.now();
    const r = await autocannon({
      url: target,
      connections: conns,
      duration: DURATION,
      pipelining: PIPELINING,
      headers: { accept: 'text/html' },
    });
    const wallMs = Date.now() - t0;
    const row = {
      path,
      connections: conns,
      duration_s: DURATION,
      wall_ms: wallMs,
      requests_total: r.requests.total,
      requests_per_sec: Math.round(r.requests.average),
      throughput_mb_s: +(r.throughput.average / 1024 / 1024).toFixed(2),
      latency_avg_ms: +r.latency.average.toFixed(2),
      latency_p50_ms: +r.latency.p50.toFixed(2),
      latency_p95_ms: +r.latency.p97_5.toFixed(2),
      latency_p99_ms: +r.latency.p99.toFixed(2),
      latency_max_ms: +r.latency.max.toFixed(2),
      errors: r.errors,
      timeouts: r.timeouts,
      non_2xx: r.non2xx,
    };
    results.push(row);
    const ok = !P95_BUDGET || row.latency_p95_ms <= P95_BUDGET;
    console.log(
      `${ok ? 'ok ' : 'FAIL'} ` +
        `qps=${row.requests_per_sec.toString().padStart(5)} ` +
        `p50=${row.latency_p50_ms.toString().padStart(5)}ms ` +
        `p95=${row.latency_p95_ms.toString().padStart(5)}ms ` +
        `p99=${row.latency_p99_ms.toString().padStart(5)}ms ` +
        `errs=${row.errors + row.timeouts + row.non_2xx}`
    );
  }
}

console.log('\n=== summary table ===');
console.log(['path', 'conns', 'qps', 'p50', 'p95', 'p99', 'errs'].map(s => s.padEnd(12)).join(''));
for (const r of results) {
  console.log(
    [
      r.path,
      r.connections,
      r.requests_per_sec,
      r.latency_p50_ms,
      r.latency_p95_ms,
      r.latency_p99_ms,
      r.errors + r.timeouts + r.non_2xx,
    ]
      .map(s => String(s).padEnd(12))
      .join('')
  );
}

if (OUTPUT) {
  writeFileSync(
    OUTPUT,
    JSON.stringify(
      {
        meta: {
          url: URL,
          tiers: TIERS,
          duration_s: DURATION,
          paths: PATHS,
          pipelining: PIPELINING,
          timestamp: new Date().toISOString(),
          node: process.version,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(`\nresults written to ${OUTPUT}`);
}

if (P95_BUDGET) {
  const failed = results.filter(r => r.latency_p95_ms > P95_BUDGET);
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} tier(s) exceeded P95 budget of ${P95_BUDGET}ms:`);
    for (const f of failed) {
      console.error(`  ${f.path} @${f.connections}c → p95=${f.latency_p95_ms}ms`);
    }
    process.exit(1);
  }
  console.log(`\n✓ all tiers within P95 budget of ${P95_BUDGET}ms`);
}
