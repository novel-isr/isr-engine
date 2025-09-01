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
        'path',
        'fs',
        'fs/promises',
        'url',
        'http',
        'events',
        'child_process',
        'compression',
        'express',
        'node-fetch',
        'sitemap',
        'rimraf',
        'redis',
        'vite',
        '@vitejs/plugin-react',
        '@vitejs/plugin-react-swc',
        'react',
        'react-dom',
        'react-router-dom',
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
