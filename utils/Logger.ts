/**
 * Simple Logger utility
 */
export class Logger {
  private verbose: boolean;
  private levels: Record<string, number>;
  private currentLevel: number;

  constructor(verbose = false) {
    this.verbose = verbose;
    this.levels = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3,
    };
    this.currentLevel = verbose ? this.levels.DEBUG : this.levels.INFO;
  }

  error(...args: any[]) {
    if (this.currentLevel >= this.levels.ERROR) {
      console.error(`[ISR-Engine ERROR] ${new Date().toISOString()}:`, ...args);
    }
  }

  warn(...args: any[]) {
    if (this.currentLevel >= this.levels.WARN) {
      console.warn(`[ISR-Engine WARN] ${new Date().toISOString()}:`, ...args);
    }
  }

  info(...args: any[]) {
    if (this.currentLevel >= this.levels.INFO) {
      console.info(`[ISR-Engine INFO] ${new Date().toISOString()}:`, ...args);
    }
  }

  debug(...args: any[]) {
    if (this.currentLevel >= this.levels.DEBUG) {
      console.debug(`[ISR-Engine DEBUG] ${new Date().toISOString()}:`, ...args);
    }
  }

  setLevel(level: string | number) {
    this.currentLevel =
      typeof level === 'string' ? this.levels[level.toUpperCase()] : level;
  }
}
