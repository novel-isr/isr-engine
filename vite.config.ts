import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: false, // 禁用rollupTypes来避免API Extractor警告
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'index.ts'),
        'cli/cli': resolve(__dirname, 'cli/cli.ts'),
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        // Node.js 内置模块
        'path',
        'fs',
        'fs/promises',
        'url',
        'http',
        'https',
        'events',
        'child_process',
        'os',
        'crypto',
        'stream',
        'util',
        'buffer',
        'querystring',
        'vm',
        'worker_threads',
        'zlib',
        'readline',
        'tty',
        'process',
        'async_hooks',
        'string_decoder',
        // Node内置模块的node:前缀版本
        'node:path',
        'node:fs',
        'node:url',
        'node:http',
        'node:https',
        'node:events',
        'node:child_process',
        'node:os',
        'node:crypto',
        'node:stream',
        'node:util',
        'node:buffer',
        'node:querystring',
        'node:vm',
        'node:worker_threads',
        'node:zlib',
        'node:readline',
        'node:tty',
        'node:process',
        'node:async_hooks',
        'node:string_decoder',
        
        // 第三方依赖
        'compression',
        'cors',
        'express',
        'node-fetch',
        'sitemap',
        'rimraf',
        'redis',
        'ioredis', 
        'lru-cache',
        'p-limit',
        'rate-limiter-flexible',
        'helmet',
        
        // CLI 工具依赖
        'commander',
        'inquirer',
        'ora',
        'chalk',
        
        // Vite 相关
        'vite',
        '@vitejs/plugin-react',
        '@vitejs/plugin-react-swc',
        
        // React 生态 - 关键修复：排除所有 React 相关模块
        'react',
        'react-dom',
        'react-dom/server',
        'react-dom/client',
        'react-router-dom',
        'react-router-dom/server',
        'react-helmet-async',
        'react-i18next',
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: '.',
        entryFileNames: chunkInfo => {
          return `${chunkInfo.name}.js`;
        },
      },
    },
    target: 'node18',
    outDir: 'dist',
    sourcemap: true,
    minify: false,
  },
  esbuild: {
    target: 'node18',
    format: 'esm',
    platform: 'node',
  },
});
