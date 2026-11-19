import { encodeLogField, snapshotLogArgument } from './logRecord';

type RuntimeLogLevel = 'debug' | 'info' | 'error';
type RuntimeLogger = Record<RuntimeLogLevel, (...args: unknown[]) => void>;

const LOGGER_KEY = Symbol.for('isr-engine:origin-logger');
const runtime = globalThis as typeof globalThis & { [LOGGER_KEY]?: RuntimeLogger };

export function setOriginLogger(logger: RuntimeLogger): void {
  runtime[LOGGER_KEY] = logger;
}

/** Rendered modules share the origin logger without bundling its file transport. */
function log(level: RuntimeLogLevel, args: unknown[]): void {
  const origin = runtime[LOGGER_KEY];
  if (origin) {
    origin[level](...args);
  } else if (level !== 'debug') {
    console[level](encodeLogField({ level, args: args.map(snapshotLogArgument) }));
  }
}

export const runtimeLogger: RuntimeLogger = {
  debug: (...args) => log('debug', args),
  info: (...args) => log('info', args),
  error: (...args) => log('error', args),
};
