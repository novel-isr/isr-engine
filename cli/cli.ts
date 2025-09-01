#!/usr/bin/env node

/**
 * Novel ISR 引擎 CLI
 * 统一的命令行接口
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { createNovelEngine } from '../index';

// 类型定义
interface CLICommand {
  name: string;
  description: string;
}

const commands: Record<string, CLICommand> = {
  dev: { name: 'dev', description: '启动开发服务器（零配置可用）' },
  build: { name: 'build', description: '构建生产版本（自动优化）' },
  start: { name: 'start', description: '启动生产服务器' },
  deploy: { name: 'deploy', description: '构建并生成部署资源' },
  stats: { name: 'stats', description: '显示运行统计' },
  init: { name: 'init', description: '生成配置文件模板' },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// 获取命令行参数
const [, , command, ...args] = process.argv;

// 运行 CLI 主函数
async function runCLI(): Promise<void> {
  // 处理帮助命令
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }

  const engine = createNovelEngine();

  try {
    switch (command) {
      case 'dev':
        console.log('🎯 Novel ISR - 开发模式');
        console.log('   自动降级链: ISR → SSR → CSR');
        console.log('   基于配置的智能路由\n');
        await engine.dev();
        break;

      case 'build':
        console.log('🎯 Novel ISR - 构建模式');
        console.log('   构建生产优化版本');
        console.log('   自动生成 SEO 文件和预渲染页面\n');
        await engine.build();
        break;

      case 'start':
        console.log('🎯 Novel ISR - 生产模式');
        console.log('   启动生产优化服务器\n');
        await engine.start();
        break;

      case 'deploy':
        console.log('🎯 Novel ISR - 部署模式');
        console.log('   构建并生成部署资源\n');
        await engine.deploy();
        break;

      case 'stats':
        await engine.initialize();
        const stats = engine.getStats();
        console.log('\n📊 Novel ISR 统计信息:');
        console.log(JSON.stringify(stats, null, 2));
        break;

      case 'init':
        await initializeProject();
        break;

      default:
        showHelp();
    }
  } catch (error) {
    console.error('❌ 错误:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// 项目初始化 - 生成配置文件模板
async function initializeProject(): Promise<void> {
  console.log('🎯 Novel ISR 项目初始化\n');

  const cwd = process.cwd();
  const configJsPath = resolve(cwd, 'ssr.config.js');
  const configTsPath = resolve(cwd, 'ssr.config.ts');

  // 检查是否已有配置文件
  if (existsSync(configJsPath) || existsSync(configTsPath)) {
    console.log('⚠️  配置文件已存在，跳过生成');
    console.log('   如需重新生成，请先删除现有的 ssr.config.js 或 ssr.config.ts');
    return;
  }

  // JavaScript 配置模板
  const jsConfigTemplate = `// Novel ISR 引擎配置文件
export default {
  // 默认渲染模式
  mode: 'isr',
  
  // 服务器配置
  server: {
    port: 3000,
    host: 'localhost'
  },
  
  // 路由配置 - 定义不同路径的渲染模式
  routes: {
    '/': 'ssg',           // 首页静态生成
    '/about': 'ssg',      // 关于页面静态生成
    '/posts/*': 'isr',    // 博客页面增量静态再生
    '/*': 'isr'           // 其他页面使用 ISR
  },
  
  // ISR 配置
  isr: {
    revalidate: 3600,              // 重新生成间隔（秒）
    backgroundRevalidation: true   // 后台重新生成
  },
  
  // 缓存配置
  cache: {
    strategy: 'memory',  // 'memory' | 'redis' | 'filesystem'
    ttl: 3600           // 缓存时间（秒）
  },
  
  // SEO 优化
  seo: {
    enabled: true,
    generateSitemap: true,
    generateRobots: true,
    baseUrl: 'http://localhost:3000'  // 生产环境请修改为实际域名
  },
  
  // 开发配置
  dev: {
    verbose: true,  // 详细日志
    hmr: true      // 热模块替换
  }
};
`;

  // TypeScript 配置模板
  const tsConfigTemplate = `// Novel ISR 引擎配置文件
import type { NovelSSRConfig } from '@novel-isr/engine';

export default {
  // 默认渲染模式
  mode: 'isr',
  
  // 服务器配置
  server: {
    port: 3000,
    host: 'localhost'
  },
  
  // 路由配置 - 定义不同路径的渲染模式
  routes: {
    '/': 'ssg',           // 首页静态生成
    '/about': 'ssg',      // 关于页面静态生成
    '/posts/*': 'isr',    // 博客页面增量静态再生
    '/*': 'isr'           // 其他页面使用 ISR
  },
  
  // ISR 配置
  isr: {
    revalidate: 3600,              // 重新生成间隔（秒）
    backgroundRevalidation: true   // 后台重新生成
  },
  
  // 缓存配置
  cache: {
    strategy: 'memory',  // 'memory' | 'redis' | 'filesystem'
    ttl: 3600           // 缓存时间（秒）
  },
  
  // SEO 优化
  seo: {
    enabled: true,
    generateSitemap: true,
    generateRobots: true,
    baseUrl: 'http://localhost:3000'  // 生产环境请修改为实际域名
  },
  
  // 开发配置
  dev: {
    verbose: true,  // 详细日志
    hmr: true      // 热模块替换
  }
} satisfies NovelSSRConfig;
`;

  try {
    // 检查项目是否使用 TypeScript
    const packageJsonPath = resolve(cwd, 'package.json');
    let useTypeScript = false;

    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      useTypeScript = !!(
        packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript
      );
    }

    // 生成配置文件
    if (useTypeScript) {
      writeFileSync(configTsPath, tsConfigTemplate, 'utf8');
      console.log('✅ 生成 TypeScript 配置文件: ssr.config.ts');
    } else {
      writeFileSync(configJsPath, jsConfigTemplate, 'utf8');
      console.log('✅ 生成 JavaScript 配置文件: ssr.config.js');
    }

    console.log('\n🚀 初始化完成！下一步：');
    console.log('   npx novel-isr dev    # 启动开发服务器');
    console.log('   npx novel-isr build  # 构建生产版本\n');
  } catch (error) {
    console.error('❌ 初始化失败:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// 显示帮助信息
function showHelp(): void {
  console.log(`
🎯 Novel ISR 引擎 - 企业级增量静态再生引擎

⚡ 零配置启动:
  npx novel-isr dev

💡 使用方法:
  novel-isr <command>

📋 命令:
  dev        启动开发服务器（零配置，直接可用）
  build      构建生产版本（自动优化）
  start      启动生产服务器
  deploy     构建并生成部署资源
  stats      显示运行统计
  init       生成配置文件模板

🚀 快速开始:
  npx novel-isr dev           # 立即启动（无需配置）
  npx novel-isr init          # 生成配置文件
  npx novel-isr build         # 构建生产版本

🔌 内置功能:
  ✅ Vite + React + TypeScript - 无需额外安装
  ✅ ISR → SSR → CSR 自动降级链
  ✅ SEO 优化 (robots.txt + sitemap.xml)
  ✅ 缓存系统 + 性能监控
  ✅ 热模块替换 (HMR) 开发体验

📝 自定义配置:
  创建 ssr.config.js 或 ssr.config.ts 来个性化配置

📚 文档:
  README.md - 完整文档
  QUICK-START.md - 快速入门
`);
}

// 运行 CLI
runCLI().catch(error => {
  console.error('❌ CLI 错误:', error);
  process.exit(1);
});
