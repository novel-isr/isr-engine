/**
 * 框架级默认配置常量
 *
 * 集中管理所有默认值，消除分散在代码各处的硬编码魔数。
 * 消费端可通过 ssr.config.* 覆盖这些默认值。
 */

/** 默认服务器端口 */
export const DEFAULT_PORT = 3000;

/** 默认服务器主机地址 */
export const DEFAULT_HOST = '0.0.0.0';

/** 默认日志文件路径 */
export const DEFAULT_LOG_FILE = './logs/isr-engine.log';

/** 默认协议 */
export const DEFAULT_PROTOCOL = 'http1.1' as const;
