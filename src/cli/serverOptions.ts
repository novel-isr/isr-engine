import type { Command } from 'commander';

/**
 * 注册服务监听参数。省略默认值是有意的：只有用户显式传参时，
 * CLI 才应覆盖 ssr.config.ts 中的 server 配置。
 */
export function addServerBindingOptions(command: Command): Command {
  return command.option('-p, --port <port>', '端口号').option('-h, --host <host>', '主机地址');
}
