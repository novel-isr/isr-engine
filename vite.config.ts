import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { builtinModules } from 'module';
import pkg from './package.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// d.ts 由 `tsc -p tsconfig.build.json` 直接 emit 多文件树（不在 vite 流程内）。
// 曾用 vite-plugin-dts + rollupTypes，但多 entry 子 bundle rollup 失败 → 退化引用
// 源码路径，必须脚本兜底。直接信任 tsc 一步到位，无 hack。
export default defineConfig({
  plugins: [],
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
        'rsc/browser': resolve(__dirname, 'src/rsc/browser.ts'),
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
