#!/usr/bin/env node
/**
 * 对比两次 bench 结果（baseline vs current）—— CI 用于检测性能劣化
 *
 * 用法：
 *   node bench/compare.mjs <baseline.json> <current.json>
 *
 * 退出码：
 *   0 完成有效比较且所有指标在容忍范围内
 *   1 P95 延迟劣化 > 20% 或 QPS 下降 > 15%（任一档）
 *   2 用法错误 / 当前结果文件不可读
 *
 * 阈值环境变量：
 *   BENCH_P95_REGRESSION_PCT   默认 20    P95 +20% → 视为退化
 *   BENCH_P95_REGRESSION_MS    默认 50    P95 绝对增加超过 50ms 才视为有效退化
 *   BENCH_QPS_REGRESSION_PCT   默认 15    QPS -15% → 视为退化
 *   BENCH_MAX_NON_2XX_RATE     默认 0     当前结果非 2xx 预算；baseline 超过则整份基线无效
 *   BENCH_MAX_ERRORS           默认 0，建连错误和超时的总预算
 */
import { existsSync, readFileSync } from 'node:fs';

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error('usage: bench-compare.mjs <baseline.json> <current.json>');
  process.exit(2);
}

const P95_REGRESSION_PCT = Number(process.env.BENCH_P95_REGRESSION_PCT ?? '20');
const P95_REGRESSION_MS = Number(process.env.BENCH_P95_REGRESSION_MS ?? '50');
const QPS_REGRESSION_PCT = Number(process.env.BENCH_QPS_REGRESSION_PCT ?? '15');
const MAX_NON_2XX_RATE = Number(process.env.BENCH_MAX_NON_2XX_RATE ?? '0');
const MAX_ERRORS = Number(process.env.BENCH_MAX_ERRORS ?? '0');
for (const value of [
  P95_REGRESSION_PCT,
  P95_REGRESSION_MS,
  QPS_REGRESSION_PCT,
  MAX_NON_2XX_RATE,
  MAX_ERRORS,
]) {
  if (!Number.isFinite(value) || value < 0) {
    console.error('invalid bench budget: expected a finite non-negative number');
    process.exit(2);
  }
}
if (!existsSync(baselinePath)) {
  console.error(
    `required baseline not found: ${baselinePath}; acquire both revisions on the same runner`
  );
  process.exit(1);
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
  meta: current.meta,
});
if (currentHealthIssues.length > 0) {
  console.error(`current bench result is unhealthy; refusing to compare perf numbers:`);
  for (const issue of currentHealthIssues) console.error(`  ${issue}`);
  process.exit(1);
}

const compatibilityIssues = collectCompatibilityIssues(baseline.meta, current.meta);
if (compatibilityIssues.length > 0) {
  console.log(`baseline protocol is incompatible with current bench run; refusing comparison.`);
  console.log(`incompatible fields:`);
  for (const issue of compatibilityIssues) console.log(`  ${issue}`);
  console.log(
    `\nRequired regression comparison did not run. Measure both revisions with the current harness on the same runner.`
  );
  process.exit(1);
}

const baselineHealthIssues = collectHealthIssues(baseline.results, {
  maxNon2xxRate: MAX_NON_2XX_RATE,
  maxErrors: MAX_ERRORS,
  meta: baseline.meta,
});
if (baselineHealthIssues.length > 0) {
  console.log(`baseline is unhealthy; refusing regression comparison and requiring reseed.`);
  console.log(`unhealthy baseline rows:`);
  for (const issue of baselineHealthIssues) console.log(`  ${issue}`);
  console.log(
    `\nRequired regression comparison did not run. Acquire a healthy baseline from the base revision on the same runner.`
  );
  process.exit(1);
}

const baselineKeys = baseline.results.map(r => `${r.path}|${r.connections}`).sort();
const currentKeys = current.results.map(r => `${r.path}|${r.connections}`).sort();
if (JSON.stringify(baselineKeys) !== JSON.stringify(currentKeys)) {
  console.error('required comparison rows differ between baseline and current');
  process.exit(1);
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
  const p95DeltaMs = Number(cur.latency_p95_ms) - Number(base.latency_p95_ms);
  const qpsBad = Number.isFinite(qpsDelta) && qpsDelta < -QPS_REGRESSION_PCT;
  const p95Bad =
    Number.isFinite(p95Delta) &&
    Number.isFinite(p95DeltaMs) &&
    p95Delta > P95_REGRESSION_PCT &&
    p95DeltaMs > P95_REGRESSION_MS;
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
      p95DeltaMs,
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
    if (r.p95Bad) {
      reasons.push(
        `P95 +${r.p95Delta.toFixed(1)}% / +${r.p95DeltaMs.toFixed(1)}ms (budget +${P95_REGRESSION_PCT}% and +${P95_REGRESSION_MS}ms)`
      );
    }
    console.error(`  ${r.path} @${r.conns}c → ${reasons.join(', ')}`);
  }
  process.exit(1);
}
console.log('\n✓ no regressions detected');

function collectHealthIssues(results, options) {
  const issues = [];
  if (!Array.isArray(results) || results.length === 0)
    return ['results must contain measured rows'];
  const seen = new Set();
  const expected = new Set(
    (options.meta?.paths ?? []).flatMap(path =>
      (options.meta?.tiers ?? []).map(tier => `${path}|${tier}`)
    )
  );
  if (expected.size === 0) issues.push('metadata must declare paths and tiers');
  for (const row of results) {
    const key = `${row.path}|${row.connections}`;
    if (seen.has(key)) issues.push(`duplicate row ${key}`);
    seen.add(key);
    if (!expected.has(key)) issues.push(`undeclared measurement ${key}`);
    if (
      options.meta?.bench_protocol >= 3 &&
      (!Number.isInteger(row.body_mismatches) || row.body_mismatches < 0)
    )
      issues.push(`${key} invalid body_mismatches`);
    if (options.meta?.scenario === 'regeneration' && row.regeneration_verified !== true)
      issues.push(`${key} regeneration not verified`);
    if (typeof row.path !== 'string' || !Number.isInteger(row.connections) || row.connections <= 0)
      issues.push(`invalid row identity ${key}`);
    for (const field of ['non_2xx_rate', 'errors', 'timeouts']) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0)
        issues.push(`${key} invalid ${field}`);
    }
    if (row.body_mismatches > 0 || row.regeneration_verified === false)
      issues.push(`${key} semantic health failure`);
    const non2xxRate = numberOrZero(row.non_2xx_rate);
    const errors = numberOrZero(row.errors) + numberOrZero(row.timeouts);
    const p95 = Number(row.latency_p95_ms);
    const qps = Number(row.requests_per_sec);
    if (non2xxRate > options.maxNon2xxRate) {
      issues.push(`${row.path} @${row.connections}c non-2xx=${non2xxRate}%`);
    }
    if (typeof options.maxErrors === 'number' && errors > options.maxErrors) {
      issues.push(`${row.path} @${row.connections}c errors+timeouts=${errors}`);
    }
    if (!Number.isFinite(qps) || qps <= 0) {
      issues.push(`${row.path} @${row.connections}c invalid QPS=${row.requests_per_sec}`);
    }
    if (!Number.isFinite(p95) || p95 < 0) {
      issues.push(`${row.path} @${row.connections}c invalid P95=${row.latency_p95_ms}`);
    }
  }
  for (const key of expected)
    if (!seen.has(key)) issues.push(`missing required measurement ${key}`);
  return issues;
}

function collectCompatibilityIssues(baselineMeta = {}, currentMeta = {}) {
  const issues = [];
  if (baselineMeta.bench_protocol !== 3 || currentMeta.bench_protocol !== 3)
    issues.push('required bench protocol is 3; remeasure both revisions with the current harness');
  compareRequiredScalar(
    issues,
    'bench_protocol',
    baselineMeta.bench_protocol,
    currentMeta.bench_protocol
  );
  compareRequiredScalar(issues, 'scenario', baselineMeta.scenario, currentMeta.scenario);
  compareRequiredScalar(issues, 'runner_id', baselineMeta.runner_id, currentMeta.runner_id);
  compareRequiredScalar(issues, 'duration_s', baselineMeta.duration_s, currentMeta.duration_s);
  compareRequiredScalar(issues, 'pipelining', baselineMeta.pipelining, currentMeta.pipelining);
  compareRequiredScalar(issues, 'warmup_s', baselineMeta.warmup_s, currentMeta.warmup_s);
  compareRequiredScalar(issues, 'cooldown_ms', baselineMeta.cooldown_ms, currentMeta.cooldown_ms);
  compareList(issues, 'tiers', baselineMeta.tiers, currentMeta.tiers);
  compareList(issues, 'paths', baselineMeta.paths, currentMeta.paths);
  compareRequiredScalar(
    issues,
    'node_major',
    majorVersion(baselineMeta.node),
    majorVersion(currentMeta.node)
  );
  return issues;
}

function compareRequiredScalar(issues, field, baselineValue, currentValue) {
  if (typeof baselineValue === 'undefined' || typeof currentValue === 'undefined') {
    issues.push(
      `${field}: baseline=${baselineValue ?? '<missing>'} current=${currentValue ?? '<missing>'}`
    );
    return;
  }
  compareScalar(issues, field, baselineValue, currentValue);
}

function compareScalar(issues, field, baselineValue, currentValue) {
  if (typeof baselineValue === 'undefined' || typeof currentValue === 'undefined') return;
  if (String(baselineValue) !== String(currentValue)) {
    issues.push(`${field}: baseline=${baselineValue} current=${currentValue}`);
  }
}

function compareList(issues, field, baselineValue, currentValue) {
  if (!Array.isArray(baselineValue) || !Array.isArray(currentValue)) {
    issues.push(`${field}: missing list`);
    return;
  }
  const baselineText = baselineValue.join(',');
  const currentText = currentValue.join(',');
  if (baselineText !== currentText) {
    issues.push(`${field}: baseline=[${baselineText}] current=[${currentText}]`);
  }
}

function majorVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^v?(\d+)/);
  return match?.[1];
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
