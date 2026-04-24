/**
 * 获取环境变量
 * @param key 环境变量名
 * @param defaultValue 默认值 (支持 string | number | boolean)
 * @returns 环境变量值或默认值
 */
export function getEnv<T extends string | number | boolean>(key: string, defaultValue: T): T;
export function getEnv(key: string): string | undefined;
export function getEnv(
  key: string,
  defaultValue?: string | number | boolean
): string | number | boolean | undefined {
  const value = process.env[key];

  if (value === undefined) {
    return defaultValue;
  }

  if (defaultValue !== undefined) {
    if (typeof defaultValue === 'number') {
      return Number(value);
    }
    if (typeof defaultValue === 'boolean') {
      return Boolean(value === 'true');
    }
  }

  return value;
}
