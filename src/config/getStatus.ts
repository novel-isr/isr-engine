import { getEnv } from './getEnv';

export const isDev = (): boolean => getEnv('NODE_ENV') !== 'production';

export const isProd = (): boolean => getEnv('NODE_ENV') === 'production';
