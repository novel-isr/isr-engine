/**
 * Exact P95 from the current driver, with legacy histogram fallbacks.
 * @param {{ latency?: { histogram?: { getValueAtPercentile?: (p: number) => number };
 *   p95?: number; p90?: number; p97_5?: number } }} result
 * @returns {number} P95 延迟（ms），找不到时返回 0
 */
export function extractP95(result) {
  if (Number.isFinite(result?.latency?.p95)) return result.latency.p95;
  const h = result?.latency?.histogram;
  if (h && typeof h.getValueAtPercentile === 'function') {
    const v = h.getValueAtPercentile(95);
    if (Number.isFinite(v) && v > 0) return +v.toFixed(2);
  }
  const p90 = result?.latency?.p90;
  const p975 = result?.latency?.p97_5;
  if (typeof p90 === 'number' && typeof p975 === 'number') {
    // P95 在 P90 与 P97.5 之间的位置：(95-90)/(97.5-90) = 5/7.5 ≈ 0.667
    return +(p90 + (p975 - p90) * (5 / 7.5)).toFixed(2);
  }
  return typeof p975 === 'number' ? +p975.toFixed(2) : 0;
}

/** 简单的 sleep helper —— 给档间 cooldown 用 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Match fixture content across React's streamed text boundaries. */
export function verifyBenchBody(path, body) {
  const html = body.toString().replace(/<!--[\s\S]*?-->/g, '');
  if (path === '/') return html.includes('<h1>Bench Home</h1>');
  if (path === '/about') return html.includes('<h1>Bench About (SSG)</h1>');
  if (path.startsWith('/books/')) return html.includes(`<h1>Book ${path.split('/')[2]}</h1>`);
  if (path === '/api/health')
    return /<pre>\{(?:&quot;|")status(?:&quot;|"):(?:&quot;|")ok(?:&quot;|")\}<\/pre>/.test(html);
  return true;
}
