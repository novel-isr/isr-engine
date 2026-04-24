/**
 * SOC 2 合规辅助代码（框架层贡献）
 *
 *   import { createAuditLogger, redactObject, redactString, addSensitiveKeys } from '@novel-isr/engine';
 *
 * 注：SOC 2 是审计认证（CPA + 6 月运营证据），框架本身不能"获得 SOC 2 认证"。
 * 但能为公司层 SOC 2 流程提供可审计的代码原语。
 */
export {
  createAuditLogger,
  type AuditEvent,
  type AuditLogger,
  type AuditLoggerOptions,
  type AuditActionOutcome,
} from './auditLog';
export { redactString, redactObject, addSensitiveKeys } from './redactPii';
