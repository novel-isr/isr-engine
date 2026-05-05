/**
 * 框架级默认配置常量
 *
 * 集中管理所有默认值，消除分散在代码各处的硬编码魔数。
 * 业务配置只声明产品/部署意图；底层 HTTP defaults 由 engine 内部管理。
 */

/** 默认服务器端口 */
export const DEFAULT_PORT = 3000;

/** 默认日志文件路径 */
export const DEFAULT_LOG_FILE = './logs/isr-engine.log';
