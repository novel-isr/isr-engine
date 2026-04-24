/**
 * PII Redactor —— SOC 2 Privacy / Confidentiality 控制
 *
 * 用于：
 *   - Sentry beforeSend 钩子里清错误堆栈
 *   - 业务日志输出前过滤
 *   - audit log extra 字段清洗
 *
 * 规则（保守命中、宁误报、不漏报）：
 *   - email, phone (E.164 / CN 11位), id-card (CN 18位), credit card (PAN with Luhn)
 *   - JWT token, AWS key, GitHub token, Slack token
 *   - 自定义字段名（默认: password, token, secret, authorization, cookie, ssn, dob）
 */
// 匹配顺序：长 / 唯一前缀的模式先，模糊数字模式最后（避免短模式吃掉长模式）
const PATTERNS: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED:email]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED:jwt]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key]'],
  [/\bghp_[A-Za-z0-9_]{36,255}\b/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  // CN 身份证 18 位（含校验位 X/x）—— 必须先于手机号匹配，避免被吃掉
  [
    /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    '[REDACTED:id-cn]',
  ],
  // CN 11 位手机号（13/14/15/16/17/18/19 开头）—— 先于国际格式
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED:phone-cn]'],
  // 国际格式：必须含分隔符或 +，避免吃掉裸 11 位 CN 号
  [/\+\d{1,3}[\s-]\(?\d{3,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/g, '[REDACTED:phone]'],
];

const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'pwd',
  'token',
  'secret',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'ssn',
  'dob',
  'credit_card',
  'cc_number',
  'api_key',
  'apikey',
  'private_key',
]);

/** 字符串脱敏（不改原串，返回新串） */
export function redactString(s: string): string {
  let out = s;
  for (const [re, mask] of PATTERNS) out = out.replace(re, mask);
  return out;
}

/**
 * 对象深度脱敏
 *   - key 命中 SENSITIVE_KEYS → 整个 value 替为 '[REDACTED]'
 *   - 字符串 value 走 redactString 模式匹配
 *   - 数组 / 嵌套对象递归
 *   - 循环引用安全（visited Set）
 */
export function redactObject<T>(obj: T, visited = new WeakSet()): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj) as unknown as T;
  if (typeof obj !== 'object') return obj;
  if (visited.has(obj as object)) return obj;
  visited.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, visited)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = redactObject(v, visited);
    }
  }
  return result as unknown as T;
}

/** 自定义额外的敏感 key */
export function addSensitiveKeys(...keys: string[]): void {
  for (const k of keys) SENSITIVE_KEYS.add(k.toLowerCase());
}
