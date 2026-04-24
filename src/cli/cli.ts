#!/usr/bin/env node

/**
 * ISR Engine CLI 主程序
 *
 * 主入口，负责命令注册和程序协调
 */

import { Command } from 'commander';
import pkg from '../../package.json';

import { startDevServer } from './dev';
import { startProductionServer } from './start';
import { showStats } from './stats';
import { runMigrate } from './migrate';
import { startFallbackProxy } from './fallback';
import { logger } from '@/logger';
import { DEFAULT_PORT, DEFAULT_HOST } from '@/config/defaults';

const program = new Command();

/**
 * 主程序配置
 */
program
  .name('novel-isr')
  .description('ISR Engine - 高性能 ISR-SSR-SSG-CSR 框架')
  .version(pkg.version);

/**
 * dev 命令 - 开发服务器
 */
program
  .command('dev')
  .description('启动开发服务器')
  .option('-p, --port <port>', '端口号', String(DEFAULT_PORT))
  .option('-h, --host <host>', '主机地址')
  .action(async options => {
    try {
      await startDevServer(options);
    } catch (error) {
      logger.error('[CLI]', '开发服务器启动失败', error);
      process.exit(1);
    }
  });

/**
 * start 命令 - 生产服务器
 */
program
  .command('start')
  .description('启动生产服务器')
  .option('-p, --port <port>', '端口号', String(DEFAULT_PORT))
  .option('-h, --host <host>', '主机地址', DEFAULT_HOST)
  .action(async options => {
    try {
      await startProductionServer(options);
    } catch (error) {
      logger.error('[CLI]', '生产服务器启动失败', error);
      process.exit(1);
    }
  });

/**
 * stats 命令 - 性能统计
 */
program
  .command('stats')
  .description('显示项目性能统计')
  .option('-p, --port <port>', '端口号')
  .option('-h, --host <host>', '主机地址')
  .option('-w, --watch', '实时监控', false)
  .option('-d, --detailed', '详细信息', false)
  .option('-f, --format <format>', '输出格式', 'console')
  .action(async options => {
    try {
      await showStats(options);
    } catch (error) {
      logger.error('[CLI]', '统计信息获取失败', error);
      process.exit(1);
    }
  });

/**
 * fallback 命令 - 本地 SSR→SPA 降级链路验证代理（nginx error_page 等价物）
 * 仅本地开发用；生产环境用 nginx
 */
program
  .command('fallback')
  .description('启动本地 fallback 代理（验证 SSR 死时自动切 SPA shell）')
  .option('-p, --port <port>', '本地代理监听端口', '8080')
  .option('--ssr-port <port>', 'SSR 上游端口', String(DEFAULT_PORT))
  .option('--api-port <port>', 'API/mock 上游端口', '3001')
  .option('--dist <path>', 'dist 根目录（含 client/ + spa/）', './dist')
  .action(options => {
    try {
      startFallbackProxy(options);
    } catch (error) {
      logger.error('[CLI]', 'fallback proxy 启动失败', error);
      process.exit(1);
    }
  });

/**
 * migrate 命令 - 扫描 Next/老 Vite 项目，给出迁移到 isr-engine 的具体修复指令
 */
program
  .command('migrate')
  .description('扫描项目，报告 Next.js / 老配置的迁移问题（不自动改代码）')
  .action(async () => {
    try {
      await runMigrate();
    } catch (error) {
      logger.error('[CLI]', 'migrate 扫描失败', error);
      process.exit(1);
    }
  });

// 主程序入口 - 直接执行
program.parse();
