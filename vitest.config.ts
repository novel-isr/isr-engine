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
      'scripts/**/__tests__/**/*.test.{js,mjs,ts}',
    ],
    exclude: ['node_modules', 'dist', 'src/defaults/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/defaults/**',
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/types/**',
      ],
    },
  },
});
