/**
 * 通用 hash 工具 —— 非加密用途的快速字符串 hash。
 *
 * 选 FNV-1a 32 位变种：
 *   - 无外部依赖（纯 JS，浏览器 / Node / edge 全部能跑）
 *   - 同一字符串永远同一结果（确定性，A/B 分桶 + cache key digest 都需要）
 *   - 雪崩效应足够好（单字符变化 → 大范围 bit 变化）
 *   - 不用于密码 / 安全场景（那种应当走 SHA / HMAC）
 *
 * 跟 ISR cache 里 extractVariantDigest 用的同一份 hash —— 行为可预测。
 */

/**
 * FNV-1a 32-bit hash —— 返回无符号 32 位整数。
 *
 * 算法常量遵循 Fowler/Noll/Vo 规范：
 *   offset basis = 0x811c9dc5
 *   prime        = 0x01000193
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a 32-bit → base36 字符串。供 cache key digest 用，简短稳定 */
export function fnv1a32Base36(input: string): string {
  return fnv1a32(input).toString(36);
}
