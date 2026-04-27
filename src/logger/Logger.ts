import ora, { Ora } from 'ora';
import fs from 'fs';
import path from 'path';
import { getTraceId, getRequestId } from '../context/RequestContext';

/**
 * 极简 ANSI 颜色封装 —— 替代 chalk, 零依赖.
 * 仅在 stdout 是 TTY 且不是 NO_COLOR / dumb terminal 时启用.
 *
 * 设计取舍:
 *   - 不引 chalk (~20KB + 类型) 给一个 logger 上色, 太重
 *   - 不做 256/truecolor / nesting / link 等 chalk 高级特性, 不需要
 *   - TTY 检测对齐 chalk 默认行为, CI 环境与 file output 自动降级到 plain
 */
const supportsColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout?.isTTY);
})();

type Colorize = (s: string) => string;
const wrap = (open: string, close = '\x1b[0m'): Colorize =>
  supportsColor ? (s: string) => `${open}${s}${close}` : (s: string) => s;

const c = {
  gray: wrap('\x1b[90m'),
  red: wrap('\x1b[31m'),
  redBold: wrap('\x1b[1;31m'),
  yellow: wrap('\x1b[33m'),
  yellowBold: wrap('\x1b[1;33m'),
  green: wrap('\x1b[32m'),
  greenBold: wrap('\x1b[1;32m'),
  blue: wrap('\x1b[34m'),
  blueBold: wrap('\x1b[1;34m'),
  magenta: wrap('\x1b[35m'),
  cyan: wrap('\x1b[36m'),
  white: wrap('\x1b[37m'),
};

export enum LogLevel {
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  SUCCESS = 'success',
}

export interface LoggerOptions {
  verbose?: boolean;
  logFile?: string;
}

export class Logger {
  private static instance: Logger;
  private verboseMode: boolean = false;
  private logFile: string | null = null;
  private spinner: Ora | null = null;

  public static getInstance(options: LoggerOptions = {}): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }

    if (options.verbose !== undefined) {
      Logger.instance.verboseMode = options.verbose;
    }

    if (options.logFile !== undefined) {
      Logger.instance.logFile = options.logFile;
      try {
        const dir = path.dirname(options.logFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      } catch (error) {
        console.error('Failed to create log directory:', error);
      }
    }

    return Logger.instance;
  }

  private formatMessage(level: LogLevel, colorize: boolean, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const levelName = level.toUpperCase();
    const traceId = getTraceId();
    const requestId = getRequestId();

    let levelTag = `[${levelName}]`;
    let traceTag = `[${traceId}]`;
    let requestTag = requestId !== 'unknown' ? `[${requestId}]` : '';

    const message = args
      .map(arg => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
      })
      .join(' ');

    if (colorize) {
      const levelColor = this.getLevelColor(level);
      levelTag = levelColor(levelTag);
      traceTag = c.cyan(traceTag);
      requestTag = requestTag ? c.blue(requestTag) : '';
      return `${c.gray(timestamp)} ${traceTag} ${requestTag} ${levelTag} ${message}`;
    }

    return `${timestamp} ${traceTag} ${requestTag} ${levelTag} ${message}`;
  }

  private getLevelColor(level: LogLevel): Colorize {
    switch (level) {
      case LogLevel.ERROR:
        return c.redBold;
      case LogLevel.WARN:
        return c.yellowBold;
      case LogLevel.SUCCESS:
        return c.greenBold;
      case LogLevel.INFO:
        return c.blueBold;
      case LogLevel.DEBUG:
        return c.magenta;
      case LogLevel.VERBOSE:
        return c.gray;
      default:
        return c.white;
    }
  }

  private writeToFile(message: string) {
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, message + '\n');
      } catch (error) {
        // Prevent infinite loop if logging fails
        process.stderr.write(`Failed to write to log file: ${error}\n`);
      }
    }
  }

  public log(level: LogLevel, ...args: unknown[]) {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.stop();
    }

    if (level === LogLevel.VERBOSE && !this.verboseMode) return;
    if (level === LogLevel.DEBUG && !this.verboseMode) return;

    // Console output
    console.log(this.formatMessage(level, true, ...args));

    // File output
    if (this.logFile) {
      this.writeToFile(this.formatMessage(level, false, ...args));
    }

    if (this.spinner && !this.spinner.isSpinning) {
      this.spinner.start();
    }
  }

  public error(...args: unknown[]) {
    this.log(LogLevel.ERROR, ...args);
  }

  public warn(...args: unknown[]) {
    this.log(LogLevel.WARN, ...args);
  }

  public info(...args: unknown[]) {
    this.log(LogLevel.INFO, ...args);
  }

  public success(...args: unknown[]) {
    this.log(LogLevel.SUCCESS, ...args);
  }

  public debug(...args: unknown[]) {
    this.log(LogLevel.DEBUG, ...args);
  }

  public verbose(...args: unknown[]) {
    this.log(LogLevel.VERBOSE, ...args);
  }

  public spin(message: string): Ora {
    if (this.spinner) {
      this.spinner.succeed();
    }
    this.spinner = ora(message).start();
    return this.spinner;
  }

  public stopSpinner(message?: string, success: boolean = true) {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(message);
      } else {
        this.spinner.fail(message);
      }
      this.spinner = null;
    }
  }
}
