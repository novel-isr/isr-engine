import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import { builtinModules } from 'module';
import pkg from './package.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [
    dts({
      // 关键：把每个 entry 的全部 types rollup 成单文件, 文件名 = entry 名
      // 例: src/index.ts → dist/novel-isr.d.ts (与 dist/novel-isr.js 配对, package.json types 字段直指)
      // 默认行为是按源码目录结构逐文件 emit, 会产出 dist/src/index.d.ts 这种带 src 前缀的路径, 与 exports 字段对不上
      rollupTypes: true,
      tsconfigPath: './tsconfig.json',
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    lib: {
      entry: {
        'novel-isr': resolve(__dirname, 'src/index.ts'),
        'cli/cli': resolve(__dirname, 'src/cli/cli.ts'),
        // 独立 rsc 子入口 —— 仅包含 RSC 环境安全的导出（revalidatePath/revalidateTag
        // / server action registry），不含 react-dom/server 等 Node-only 模块
        'rsc/index': resolve(__dirname, 'src/rsc/index.ts'),
        // 可观测性 SDK 预制 adapter 子路径 —— 树摇友好（用户只引 Sentry 时不会拉 Datadog）
        'adapters/observability/index': resolve(__dirname, 'src/adapters/observability/index.ts'),
        // Edge runtime adapter（CF Workers / Vercel Edge；Deno / Bun 走原生 `{fetch}`）
        'adapters/runtime/index': resolve(__dirname, 'src/adapters/runtime/index.ts'),
        // <Image> 组件 —— 用户在 React 树里引用
        'image/index': resolve(__dirname, 'src/runtime/Image.tsx'),
      },
      // 注：内置默认 SSR 入口（src/defaults/entry.server.ssr.tsx）不在此处打包，
      // 因为它依赖 `import.meta.viteRsc`（plugin-rsc 运行时注入的 API），
      // 只能在用户项目的 plugin-rsc 构建上下文里被消费。我们直接以源码形式
      // 暴露给用户的 plugin-rsc 进行二次打包，详见 createIsrPlugin.ts
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map(m => `node:${m}`),
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.optionalDependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        // 子路径外部化（如 react-dom/server, react-dom/client）
        /^react(-dom)?(\/.*)?$/,
        // 可选 SDK —— 用户没装时静默跳过（adapters/observability 里 dynamic import）
        // 不写进 deps（避免强制安装），但必须 external 防止 bundler inline + 解析失败
        'web-vitals',
        '@sentry/browser',
        '@sentry/node',
        'dd-trace',
        /^@opentelemetry\/.*/,
      ],
    },
    target: 'node20',
    outDir: 'dist',
    sourcemap: true,
    minify: false,
  },
});
