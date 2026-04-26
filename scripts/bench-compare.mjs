#!/usr/bin/env node
/**
 * 对比两次 bench 结果（baseline vs current）—— CI 用于检测性能劣化
 *
 * 用法：
 *   node scripts/bench-compare.mjs <baseline.json> <current.json>
 *
 * 退出码：
 *   0 所有指标在容忍范围内 / baseline 缺失（首次运行，自动 skip）
 *   1 P95 延迟劣化 > 20% 或 QPS 下降 > 15%（任一档）
 *   2 用法错误 / 当前结果文件不可读
 *
 * 阈值环境变量：
 *   BENCH_P95_REGRESSION_PCT   默认 20    P95 +20% → 视为退化
 *   BENCH_QPS_REGRESSION_PCT   默认 15    QPS -15% → 视为退化
 */
import { existsSync, readFileSync } from 'node:fs';

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error('usage: bench-compare.mjs <baseline.json> <current.json>');
  process.exit(2);
}

const P95_REGRESSION_PCT = parseFloat(process.env.BENCH_P95_REGRESSION_PCT ?? '20');
const QPS_REGRESSION_PCT = parseFloat(process.env.BENCH_QPS_REGRESSION_PCT ?? '15');

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
  const qpsDelta = ((cur.requests_per_sec - base.requests_per_sec) / base.requests_per_sec) * 100;
  const p95Delta = ((cur.latency_p95_ms - base.latency_p95_ms) / base.latency_p95_ms) * 100;
  const qpsBad = qpsDelta < -QPS_REGRESSION_PCT;
  const p95Bad = p95Delta > P95_REGRESSION_PCT;
  const flag = qpsBad || p95Bad ? '✗' : '✓';
  console.log(
    `${flag} ${cur.path.padEnd(13)}${String(cur.connections).padEnd(6)}` +
      `${(qpsDelta >= 0 ? '+' : '') + qpsDelta.toFixed(1)}%`.padEnd(10) +
      `${(p95Delta >= 0 ? '+' : '') + p95Delta.toFixed(1)}%`
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
