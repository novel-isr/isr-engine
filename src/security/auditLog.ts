/**
 * Audit Log —— SOC 2 Security / Processing Integrity 标准要求
 *
 * 输出 NDJSON（JSON-lines）到 stderr 或文件，字段固定：
 *   ts / actor / action / resource / outcome / requestId / ip / userAgent
 *
 * 不做写入持久化 —— 交给 infrastructure (syslog / Loki / Splunk 等)
 * 由 stdout/stderr pipeline 自动收集。
 */
import { promises as fs } from 'node:fs';

export type AuditActionOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  /** 动作名，统一 lowercase_snake：cache_clear / admin_login / config_change 等 */
  action: string;
  /** 谁干的：email / userId / 'system' / 'anonymous' */
  actor: string;
  /** 被操作的对象：path / resourceId / 'global' */
  resource: string;
  /** 结果 */
  outcome: AuditActionOutcome;
  /** 请求关联的 trace-id（方便串联应用日志） */
  requestId?: string;
  /** 客户端 IP（X-Forwarded-For 第一段；本地用 '::1'） */
  ip?: string;
  userAgent?: string;
  /** 任何额外结构化 context，不会打印 PII —— 调用方自己做脱敏 */
  extra?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** 'stderr' | 'file:/path/to/audit.log' | custom writer fn */
  sink?: 'stderr' | 'stdout' | `file:${string}` | ((line: string) => void);
  /** 是否同步写（默认 false —— 避免阻塞热路径） */
  sync?: boolean;
}

export interface AuditLogger {
  log(event: AuditEvent): void;
  /** 优雅关闭：flush 所有挂起的写入 */
  close(): Promise<void>;
}

export function createAuditLogger(options: AuditLoggerOptions = {}): AuditLogger {
  const sink = options.sink ?? 'stderr';
  const pending: Promise<unknown>[] = [];

  const write = (line: string): void => {
    if (typeof sink === 'function') {
      sink(line);
      return;
    }
    if (sink === 'stdout') {
      process.stdout.write(line + '\n');
      return;
    }
    if (sink === 'stderr') {
      process.stderr.write(line + '\n');
      return;
    }
    if (sink.startsWith('file:')) {
      const path = sink.slice(5);
      const p = fs.appendFile(path, line + '\n').catch(err => {
        process.stderr.write(`[audit-log] file write failed: ${String(err)}\n`);
      });
      if (!options.sync) pending.push(p);
      return;
    }
  };

  return {
    log(event) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...event,
      });
      write(line);
    },
    async close() {
      await Promise.allSettled(pending);
    },
  };
}
