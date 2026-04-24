import { Logger } from './Logger';
import { DEFAULT_LOG_FILE } from '../config/defaults';

export const logger = Logger.getInstance({
  verbose: true,
  logFile: DEFAULT_LOG_FILE,
});
