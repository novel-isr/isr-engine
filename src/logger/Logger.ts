import chalk from 'chalk';
import ora, { Ora } from 'ora';
import path from 'path';
import pino, { type Logger as PinoLogger } from 'pino';
import { getTraceId, getRequestId } from '../context/RequestContext';
import {
  encodeLogField,
  encodeSpinnerMessage,
  escapeSupplementalLogControls,
  snapshotLogArgument,
  type LogValue,
} from './logRecord';
import { setOriginLogger } from './runtimeLogger';

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
  private fileLogger: PinoLogger | null = null;
  private fileDestination: ReturnType<typeof pino.destination> | null = null;
  private spinner: Ora | null = null;

  public static getInstance(options: LoggerOptions = {}): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
      setOriginLogger(Logger.instance);
    }

    if (options.verbose !== undefined) {
      Logger.instance.verboseMode = options.verbose;
    }

    if (options.logFile !== undefined) {
      Logger.instance.configureFile(options.logFile);
    }

    return Logger.instance;
  }

  /** File destinations are operator configuration; request data is only a record field. */
  private configureFile(logFile: string): void {
    // eslint-disable-next-line no-control-regex
    if (typeof logFile !== 'string' || /[\u0000-\u001f\u007f]/.test(logFile)) {
      throw new TypeError('logFile must be a path without control characters');
    }
    const resolved = logFile ? path.resolve(logFile) : null;
    if (resolved === this.logFile) return;
    this.closeFileDestination();
    if (!resolved) return;

    try {
      const destination = pino.destination({ dest: resolved, mkdir: true, sync: true });
      destination.on('error', error => {
        if (this.fileDestination === destination) this.closeFileDestination();
        this.reportFileError(error);
      });
      destination.once('close', () => {
        if (this.fileDestination !== destination) return;
        this.fileLogger = null;
        this.fileDestination = null;
        this.logFile = null;
      });
      this.fileDestination = destination;
      this.fileLogger = pino(
        {
          base: null,
          timestamp: false,
          level: 'trace',
          hooks: { streamWrite: escapeSupplementalLogControls },
        },
        destination
      );
      this.logFile = resolved;
    } catch (error) {
      this.closeFileDestination();
      this.reportFileError(error);
    }
  }

  private closeFileDestination(): void {
    const destination = this.fileDestination;
    this.fileLogger = null;
    this.fileDestination = null;
    this.logFile = null;
    if (!destination) return;
    try {
      destination.flushSync();
      destination.end();
    } catch (error) {
      destination.destroy();
      this.reportFileError(error);
    }
  }

  private reportFileError(error: unknown): void {
    try {
      process.stderr.write(
        `Failed to write to log file: ${encodeLogField(snapshotLogArgument(error))}\n`
      );
    } catch {
      // Logging failure must never recurse or prevent serving a request.
    }
  }

  private getLevelColor(level: LogLevel) {
    switch (level) {
      case LogLevel.ERROR:
        return chalk.red.bold;
      case LogLevel.WARN:
        return chalk.yellow.bold;
      case LogLevel.SUCCESS:
        return chalk.green.bold;
      case LogLevel.INFO:
        return chalk.blue.bold;
      case LogLevel.DEBUG:
        return chalk.magenta;
      case LogLevel.VERBOSE:
        return chalk.gray;
      default:
        return chalk.white;
    }
  }

  public log(level: LogLevel, ...args: unknown[]) {
    if (!Object.values(LogLevel).includes(level)) {
      throw new TypeError('Unknown log level');
    }

    if (level === LogLevel.VERBOSE && !this.verboseMode) return;
    if (level === LogLevel.DEBUG && !this.verboseMode) return;

    if (this.spinner?.isSpinning) this.spinner.stop();

    const timestamp = new Date().toISOString();
    const traceId = snapshotLogArgument(getTraceId());
    const requestId = snapshotLogArgument(getRequestId());
    const values = args.map(snapshotLogArgument);
    const errors: Array<{ argument: number; error: LogValue }> = [];
    const message = values
      .map((value, index) => {
        if (args[index] instanceof Error) {
          errors.push({ argument: index, error: value });
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value.stack || value.message || JSON.stringify(value, null, 2);
          }
        }
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      })
      .join(' ');

    // Encode each field before adding only the logger's own ANSI color sequences.
    const levelTag = this.getLevelColor(level)(`[${level.toUpperCase()}]`);
    const traceTag = chalk.cyan(`traceId=${encodeLogField(traceId)}`);
    const requestTag =
      requestId === 'unknown' ? '' : chalk.blue(`requestId=${encodeLogField(requestId)}`);
    console.log(
      `${chalk.gray(timestamp)} ${levelTag} ${traceTag} ${requestTag} message=${encodeLogField(message)}`
    );

    if (this.fileLogger) {
      const transportLevel =
        level === LogLevel.VERBOSE ? 'trace' : level === LogLevel.SUCCESS ? 'info' : level;
      try {
        this.fileLogger[transportLevel]({
          timestamp,
          severity: level,
          traceId,
          requestId,
          args: values,
          errors,
        });
      } catch (error) {
        this.closeFileDestination();
        this.reportFileError(error);
      }
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
    this.spinner = ora(encodeSpinnerMessage(message)).start();
    return this.spinner;
  }

  public stopSpinner(message?: string, success: boolean = true) {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(message === undefined ? undefined : encodeSpinnerMessage(message));
      } else {
        this.spinner.fail(message === undefined ? undefined : encodeSpinnerMessage(message));
      }
      this.spinner = null;
    }
  }
}
