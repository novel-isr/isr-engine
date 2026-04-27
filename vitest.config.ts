import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 单元测试配置 —— 与 vite.config.ts 共享 alias，但不构建产物
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'bench/__tests__/**/*.test.{js,mjs,ts}',
    ],
    exclude: [
      'node_modules',
      'dist',
      // 这些 wrapper 引用 @vitejs/plugin-rsc 的 import.meta.viteRsc / virtual:vite-rsc/*
      // 只能在用户项目的 plugin-rsc 构建上下文里被消费，不能直接在 vitest 跑
      'src/defaults/runtime/defineServerEntry.tsx',
      'src/defaults/runtime/defineClientEntry.tsx',
      'src/defaults/entry.tsx',
      'src/defaults/entry.server.tsx',
      'src/defaults/entry.server.ssr.tsx',
      // bench-fixture 是独立 sub-package，它的 node_modules 含自己 deps 的测试，
      // 不应该被引擎主测套覆盖
      'bench/fixture/**',
    ],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/defaults/**', 'src/**/*.test.ts', 'src/**/__tests__/**', 'src/types/**'],
    },
  },
});
