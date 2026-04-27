#!/usr/bin/env node
/**
 * 多档并发 HTTP 基准测试 —— 用 autocannon 验证 isr-engine 在不同负载下的表现
 *
 * 流水线：
 *   preflight  → 每条 path 单 GET 校验 2xx，把死配置 fail-fast 暴露
 *   stats(pre) → 拉 /__isr/stats（可选）记录 bench 开始前的 cache 状态
 *   warmup     → 每条 path 短跑 autocannon（让 JIT 稳态 + 把 cache 全填上 HIT）
 *   bench      → 多档并发主测，每档间 cooldown
 *   stats(post)→ 再拉 /__isr/stats，diff 显示 bench 期间多少 entry 进入缓存
 *   summary    → 按 path 分组汇总
 *
 * 用法：
 *   pnpm bench                          # 默认本地 :3000，全档位
 *   BENCH_URL=https://x pnpm bench       # 指定目标
 *   BENCH_TIERS=100,1000 pnpm bench      # 指定并发档
 *   BENCH_DURATION=20 pnpm bench         # 每档持续秒数
 *   BENCH_PATHS=/,/books/1 pnpm bench    # 指定路径
 *   BENCH_OUTPUT=bench.json pnpm bench   # 写 JSON 结果（CI 比较用）
 *
 *   # CI 门槛
 *   BENCH_P95_BUDGET_MS=500 pnpm bench   # 任一档 P95 超 → exit 1
 *   BENCH_QPS_FLOOR=100 pnpm bench       # 任一档 QPS 低于此值 → exit 1
 *   BENCH_FAIL_ON_NON_2XX=1 pnpm bench   # 任一档 non-2xx 比例 > 5% → exit 1
 *
 * 退出码：
 *   0 全部 P95 / QPS / non-2xx 在阈值内（或未开门槛）
 *   1 任一门槛被打破
 *   2 preflight 失败（服务器没起来 / 路径返回 4xx/5xx）
 */
import autocannon from 'autocannon';
import { writeFileSync } from 'node:fs';
import { extractP95, sleep } from './utils.mjs';

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
const QPS_FLOOR = process.env.BENCH_QPS_FLOOR ? parseInt(process.env.BENCH_QPS_FLOOR, 10) : null;
const FAIL_ON_NON_2XX = process.env.BENCH_FAIL_ON_NON_2XX === '1';
const PIPELINING = parseInt(process.env.BENCH_PIPELINING ?? '1', 10);
// Per-path warmup duration（每条 path 单独跑一遍 autocannon 预热；让首次 MISS
// 不污染主测，并把 ISR cache 全部填上 HIT）。默认 3s，设 0 关闭。
const WARMUP_SECONDS = parseInt(process.env.BENCH_WARMUP_SECONDS ?? '3', 10);
// 档间 cooldown：释放上一档的 keep-alive 连接 + 留给 GC / event-loop 恢复的时间。
const COOLDOWN_MS = parseInt(process.env.BENCH_COOLDOWN_MS ?? '2000', 10);
// preflight 单 GET 的超时；设 0 关闭 preflight（不推荐）
const PREFLIGHT_TIMEOUT_MS = parseInt(process.env.BENCH_PREFLIGHT_TIMEOUT_MS ?? '5000', 10);
// stats 端点（可选 —— 服务器开 admin routes 时才有；缺失静默跳过）
const STATS_PATH = process.env.BENCH_STATS_PATH ?? '/__isr/stats';

console.log(`\n=== isr-engine bench ===`);
console.log(`target:      ${URL}`);
console.log(`tiers:       ${TIERS.join(', ')} concurrent connections`);
console.log(`duration:    ${DURATION}s per tier`);
console.log(`paths:       ${PATHS.join(', ')}`);
console.log(`pipelining:  ${PIPELINING}`);
console.log(`warmup:      ${WARMUP_SECONDS}s per path`);
console.log(`cooldown:    ${COOLDOWN_MS}ms (between tiers)`);
const gates = [];
if (P95_BUDGET) gates.push(`P95 ≤ ${P95_BUDGET}ms`);
if (QPS_FLOOR) gates.push(`QPS ≥ ${QPS_FLOOR}`);
if (FAIL_ON_NON_2XX) gates.push('non-2xx ≤ 5%');
console.log(`CI gates:    ${gates.length > 0 ? gates.join(' / ') : 'none (informational)'}\n`);

// ─── Preflight：每条 path 单 GET 校验 2xx ───
if (PREFLIGHT_TIMEOUT_MS > 0) {
  console.log('▶ preflight (sanity GET each path)');
  for (const path of PATHS) {
    const target = `${URL}${path}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS);
      const res = await fetch(target, { signal: ctrl.signal });
      clearTimeout(t);
      const ok = res.status >= 200 && res.status < 300;
      console.log(`   ${ok ? '✓' : '✗'} ${target} → ${res.status}`);
      if (!ok) {
        console.error(`✗ preflight failed for ${target}: status ${res.status}`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`✗ preflight failed for ${target}: ${err.message}`);
      process.exit(2);
    }
  }
}

// ─── Stats(pre)：可选地拉 /__isr/stats 记录 bench 前的 cache 状态 ───
async function fetchStats() {
  try {
    const r = await fetch(`${URL}${STATS_PATH}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
const statsBefore = await fetchStats();
if (statsBefore) {
  console.log(
    `   cache(before): ${statsBefore.size}/${statsBefore.max} entries, backend=${statsBefore.backend}`
  );
}

// ─── Warmup：每条 path 单独短跑一次 autocannon ───
// 关键：原版只 warmup PATHS[0]，导致 PATHS[1+] 在主测时还要承担首次 MISS。
// 现在每条 path 都跑 WARMUP_SECONDS，主测开始时所有路径都已稳态 HIT。
if (WARMUP_SECONDS > 0) {
  console.log(`\n▶ warmup (${WARMUP_SECONDS}s per path)`);
  for (const path of PATHS) {
    const target = `${URL}${path}`;
    process.stdout.write(`   ${target} ... `);
    await autocannon({
      url: target,
      connections: Math.min(5, TIERS[0]),
      duration: WARMUP_SECONDS,
      pipelining: PIPELINING,
      headers: { accept: 'text/html' },
    });
    console.log('done');
  }
}

// ─── 主测 ───
console.log('\n▶ bench (multi-tier × paths)');
const results = [];
let tierIndex = 0;

for (const path of PATHS) {
  for (const conns of TIERS) {
    if (tierIndex > 0 && COOLDOWN_MS > 0) {
      await sleep(COOLDOWN_MS);
    }
    tierIndex++;

    const target = `${URL}${path}`;
    process.stdout.write(`   ${target}  conns=${conns}  ... `);
    const t0 = Date.now();
    const r = await autocannon({
      url: target,
      connections: conns,
      duration: DURATION,
      pipelining: PIPELINING,
      headers: { accept: 'text/html' },
    });
    const wallMs = Date.now() - t0;
    const non2xxRate = r.requests.total > 0 ? r.non2xx / r.requests.total : 0;
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
      latency_p95_ms: extractP95(r),
      latency_p97_5_ms: +r.latency.p97_5.toFixed(2),
      latency_p99_ms: +r.latency.p99.toFixed(2),
      latency_max_ms: +r.latency.max.toFixed(2),
      errors: r.errors,
      timeouts: r.timeouts,
      non_2xx: r.non2xx,
      non_2xx_rate: +(non2xxRate * 100).toFixed(2),
    };
    results.push(row);

    // Per-tier 状态（CI gates）
    const issues = [];
    if (P95_BUDGET && row.latency_p95_ms > P95_BUDGET) issues.push(`P95>${P95_BUDGET}ms`);
    if (QPS_FLOOR && row.requests_per_sec < QPS_FLOOR) issues.push(`QPS<${QPS_FLOOR}`);
    if (FAIL_ON_NON_2XX && non2xxRate > 0.05) issues.push(`non2xx>${row.non_2xx_rate}%`);
    const tag = issues.length > 0 ? `FAIL(${issues.join(',')})` : 'ok ';
    console.log(
      `${tag} ` +
        `qps=${row.requests_per_sec.toString().padStart(5)} ` +
        `p50=${row.latency_p50_ms.toString().padStart(5)}ms ` +
        `p95=${row.latency_p95_ms.toString().padStart(5)}ms ` +
        `p99=${row.latency_p99_ms.toString().padStart(5)}ms ` +
        `errs=${row.errors + row.timeouts} non2xx=${row.non_2xx_rate}%`
    );
  }
}

// ─── Stats(post)：bench 结束后再拉一次，diff cache 增量 ───
const statsAfter = await fetchStats();
if (statsBefore && statsAfter) {
  const delta = statsAfter.size - statsBefore.size;
  console.log(
    `\n   cache(after):  ${statsAfter.size}/${statsAfter.max} entries (Δ ${delta >= 0 ? '+' : ''}${delta})`
  );
}

// ─── Summary table ───
console.log('\n=== summary by path ===');
const byPath = new Map();
for (const r of results) {
  if (!byPath.has(r.path)) byPath.set(r.path, []);
  byPath.get(r.path).push(r);
}
const colHeads = ['path', 'conns', 'qps', 'p50', 'p95', 'p99', 'non2xx%', 'errs'];
console.log(colHeads.map(s => s.padEnd(12)).join(''));
for (const [path, rows] of byPath) {
  for (const r of rows) {
    console.log(
      [
        path,
        r.connections,
        r.requests_per_sec,
        r.latency_p50_ms,
        r.latency_p95_ms,
        r.latency_p99_ms,
        r.non_2xx_rate,
        r.errors + r.timeouts,
      ]
        .map(s => String(s).padEnd(12))
        .join('')
    );
  }
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
          warmup_s: WARMUP_SECONDS,
          cooldown_ms: COOLDOWN_MS,
          timestamp: new Date().toISOString(),
          node: process.version,
        },
        stats_before: statsBefore,
        stats_after: statsAfter,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nresults written to ${OUTPUT}`);
}

// ─── 汇总 CI gates ───
const failed = [];
for (const r of results) {
  if (P95_BUDGET && r.latency_p95_ms > P95_BUDGET) {
    failed.push(`${r.path}@${r.connections}c P95=${r.latency_p95_ms}ms (budget ${P95_BUDGET}ms)`);
  }
  if (QPS_FLOOR && r.requests_per_sec < QPS_FLOOR) {
    failed.push(`${r.path}@${r.connections}c QPS=${r.requests_per_sec} (floor ${QPS_FLOOR})`);
  }
  if (FAIL_ON_NON_2XX && r.non_2xx_rate > 5) {
    failed.push(`${r.path}@${r.connections}c non-2xx=${r.non_2xx_rate}% (budget 5%)`);
  }
}
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} CI gate breach(es):`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
if (gates.length > 0) console.log(`\n✓ all tiers within CI gates`);
