#!/usr/bin/env node
/**
 * 对比两次 bench 结果（baseline vs current）—— CI 用于检测性能劣化
 *
 * 用法：
 *   node bench/compare.mjs <baseline.json> <current.json>
 *
 * 退出码：
 *   0 所有指标在容忍范围内 / baseline 缺失（首次运行，自动 skip）
 *   1 P95 延迟劣化 > 20% 或 QPS 下降 > 15%（任一档）
 *   2 用法错误 / 当前结果文件不可读
 *
 * 阈值环境变量：
 *   BENCH_P95_REGRESSION_PCT   默认 20    P95 +20% → 视为退化
 *   BENCH_QPS_REGRESSION_PCT   默认 15    QPS -15% → 视为退化
 *   BENCH_MAX_NON_2XX_RATE     默认 0     当前结果非 2xx 预算；baseline 超过则整份基线无效
 *   BENCH_MAX_ERRORS           默认 0     当前结果 errors + timeouts 预算；baseline 超过则整份基线无效
 */
import { existsSync, readFileSync } from 'node:fs';

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error('usage: bench-compare.mjs <baseline.json> <current.json>');
  process.exit(2);
}

const P95_REGRESSION_PCT = parseFloat(process.env.BENCH_P95_REGRESSION_PCT ?? '20');
const QPS_REGRESSION_PCT = parseFloat(process.env.BENCH_QPS_REGRESSION_PCT ?? '15');
const MAX_NON_2XX_RATE = parseFloat(process.env.BENCH_MAX_NON_2XX_RATE ?? '0');
const MAX_ERRORS = parseInt(process.env.BENCH_MAX_ERRORS ?? '0', 10);

// Baseline 缺失：首次跑或新分支没有基线 —— 退出 0，让 CI 把 current 作为新基线提交即可
if (!existsSync(baselinePath)) {
  console.log(`no baseline at ${baselinePath} — skipping regression check (first run?)`);
  console.log(`commit ${currentPath} as ${baselinePath} to seed future comparisons`);
  process.exit(0);
}

if (!existsSync(currentPath)) {
  console.error(`current results not found: ${currentPath}`);
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const current = JSON.parse(readFileSync(currentPath, 'utf8'));

const currentHealthIssues = collectHealthIssues(current.results, {
  maxNon2xxRate: MAX_NON_2XX_RATE,
  maxErrors: MAX_ERRORS,
});
if (currentHealthIssues.length > 0) {
  console.error(`current bench result is unhealthy; refusing to compare perf numbers:`);
  for (const issue of currentHealthIssues) console.error(`  ${issue}`);
  process.exit(1);
}

const baselineHealthIssues = collectHealthIssues(baseline.results, {
  maxNon2xxRate: MAX_NON_2XX_RATE,
  maxErrors: MAX_ERRORS,
});
if (baselineHealthIssues.length > 0) {
  console.log(`baseline is unhealthy; skipping regression comparison and requiring reseed.`);
  console.log(`unhealthy baseline rows:`);
  for (const issue of baselineHealthIssues) console.log(`  ${issue}`);
  console.log(
    `\ncurrent result is healthy. Replace ${baselinePath} with ${currentPath} on a stable runner.`
  );
  process.exit(0);
}

const baselineMap = new Map(baseline.results.map(r => [`${r.path}|${r.connections}`, r]));

console.log(`baseline: ${baselinePath}  (${baseline.meta.timestamp})`);
console.log(`current:  ${currentPath}   (${current.meta.timestamp})\n`);
console.log('path           conns  qps Δ        p95 Δ');

const regressions = [];
for (const cur of current.results) {
  const key = `${cur.path}|${cur.connections}`;
  const base = baselineMap.get(key);
  if (!base) {
    console.log(
      `${cur.path.padEnd(15)}${String(cur.connections).padEnd(6)} (new tier, no baseline)`
    );
    continue;
  }
  const qpsDelta = percentDelta(cur.requests_per_sec, base.requests_per_sec);
  const p95Delta = percentDelta(cur.latency_p95_ms, base.latency_p95_ms);
  const qpsBad = Number.isFinite(qpsDelta) && qpsDelta < -QPS_REGRESSION_PCT;
  const p95Bad = Number.isFinite(p95Delta) && p95Delta > P95_REGRESSION_PCT;
  const flag = qpsBad || p95Bad ? '✗' : '✓';
  console.log(
    `${flag} ${cur.path.padEnd(13)}${String(cur.connections).padEnd(6)}` +
      `${formatDelta(qpsDelta)}`.padEnd(10) +
      `${formatDelta(p95Delta)}`
  );
  if (qpsBad || p95Bad) {
    regressions.push({
      path: cur.path,
      conns: cur.connections,
      qpsDelta,
      p95Delta,
      qpsBad,
      p95Bad,
    });
  }
}

if (regressions.length > 0) {
  console.error(`\n✗ ${regressions.length} regression(s) detected:`);
  for (const r of regressions) {
    const reasons = [];
    if (r.qpsBad) reasons.push(`QPS ${r.qpsDelta.toFixed(1)}% (budget -${QPS_REGRESSION_PCT}%)`);
    if (r.p95Bad) reasons.push(`P95 +${r.p95Delta.toFixed(1)}% (budget +${P95_REGRESSION_PCT}%)`);
    console.error(`  ${r.path} @${r.conns}c → ${reasons.join(', ')}`);
  }
  process.exit(1);
}
console.log('\n✓ no regressions detected');

function collectHealthIssues(results, options) {
  const issues = [];
  for (const row of results ?? []) {
    const non2xxRate = numberOrZero(row.non_2xx_rate);
    const errors = numberOrZero(row.errors) + numberOrZero(row.timeouts);
    const p95 = Number(row.latency_p95_ms);
    const qps = Number(row.requests_per_sec);
    if (non2xxRate > options.maxNon2xxRate) {
      issues.push(`${row.path} @${row.connections}c non-2xx=${non2xxRate}%`);
    }
    if (errors > options.maxErrors) {
      issues.push(`${row.path} @${row.connections}c errors+timeouts=${errors}`);
    }
    if (!Number.isFinite(qps) || qps <= 0) {
      issues.push(`${row.path} @${row.connections}c invalid QPS=${row.requests_per_sec}`);
    }
    if (!Number.isFinite(p95) || p95 < 0) {
      issues.push(`${row.path} @${row.connections}c invalid P95=${row.latency_p95_ms}`);
    }
  }
  return issues;
}

function percentDelta(currentValue, baselineValue) {
  const currentNumber = Number(currentValue);
  const baselineNumber = Number(baselineValue);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber <= 0) {
    return NaN;
  }
  return ((currentNumber - baselineNumber) / baselineNumber) * 100;
}

function formatDelta(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
