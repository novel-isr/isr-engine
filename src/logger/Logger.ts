import chalk from 'chalk';
import ora, { Ora } from 'ora';
import fs from 'fs';
import path from 'path';
import { getTraceId, getRequestId } from '../context/RequestContext';

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
      traceTag = chalk.cyan(traceTag);
      requestTag = requestTag ? chalk.blue(requestTag) : '';
      return `${chalk.gray(timestamp)} ${traceTag} ${requestTag} ${levelTag} ${message}`;
    }

    return `${timestamp} ${traceTag} ${requestTag} ${levelTag} ${message}`;
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
