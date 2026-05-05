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
import { startFallbackProxy } from './fallback';
import { logger } from '@/logger';
import { DEFAULT_PORT } from '@/config/defaults';

const program = new Command();

/**
 * 主程序配置
 */
program
  .name('novel-isr')
  .description('ISR Engine — Vite + React 19 RSC 的 ISR/SSG/SSR 编排层')
  .version(pkg.version);

/**
 * dev 命令 - 开发服务器
 */
program
  .command('dev')
  .description('启动开发服务器')
  .option('-p, --port <port>', '端口号', String(DEFAULT_PORT))
  .option('-h, --host <host>', '主机地址')
  .option('--open', '启动后自动打开浏览器', true)
  .option('--no-open', '启动后不自动打开浏览器')
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
  .option('-h, --host <host>', '主机地址')
  .action(async options => {
    try {
      await startProductionServer(options);
    } catch (error) {
      logger.error('[CLI]', '生产服务器启动失败', error);
      process.exit(1);
    }
  });

/**
 * test-fallback-local 命令 - 本地 SSR→SPA 降级链路验证代理（nginx error_page 等价物）
 * 仅本地开发用；生产环境用 nginx
 */
program
  .command('test-fallback-local')
  .description('本地启动 fallback 代理，验证 SSR 死时自动切到 SPA shell')
  .option('-p, --port <port>', '本地代理监听端口', '8080')
  .option('--ssr-port <port>', 'SSR 上游端口', String(DEFAULT_PORT))
  .option('--api-port <port>', 'API/mock 上游端口', '3001')
  .option('--dist <path>', 'dist 根目录（含 client/ + spa/）', './dist')
  .action(options => {
    try {
      startFallbackProxy(options);
    } catch (error) {
      logger.error('[CLI]', 'test-fallback-local proxy 启动失败', error);
      process.exit(1);
    }
  });

// 主程序入口 - 直接执行
program.parse();
