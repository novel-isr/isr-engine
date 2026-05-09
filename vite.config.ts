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
        // ssr.config.ts 专用轻量入口。不要从根入口导入 config helper，否则会把
        // CLI/plugin/esbuild 等 Node 工具链带进消费方 RSC/SSG bundle。
        // 注：rate-limit-key 在 v2.4 收回 engine 内部 —— 业务侧改用数据驱动
        // RuntimeRateLimitConfig.userBucket，不再需要 import function。
        'config/defineConfig': resolve(__dirname, 'src/config/defineConfig.ts'),
        // ─── 消费方加载的辅助入口（无 'use client' / plugin-rsc 依赖） ────────
        // defineSiteHooks / auto-observability 是纯逻辑模块，预打包成 ESM JS
        // 让消费方 Vite scanner 能正常发现 React 等依赖（不再 alias 到源文件）。
        //
        // 注 1：defineClientEntry / defineServerEntry / entry.server.ssr.tsx 必须
        // 维持源码形式 —— 它们依赖 `@vitejs/plugin-rsc/browser` `/rsc`
        // `import.meta.viteRsc` 等 plugin-rsc 运行时虚拟模块，只能在消费方
        // plugin-rsc 构建上下文里二次打包。
        //
        // 注 2：./runtime 也维持源码形式 —— runtime/index 重导出 boundary /
        // LocaleContext / createSpaApp 等带 'use client' 指令的模块，bundle 后
        // Rollup 会丢失模块级 'use client' 指令，plugin-rsc 无法把它们识别为
        // 客户端组件引用，导致 RSC 边界错误。保持源码让 plugin-rsc 按文件粒度
        // 解析 directives。
        'defaults/runtime/defineSiteHooks': resolve(
          __dirname,
          'src/defaults/runtime/defineSiteHooks.ts'
        ),
        'defaults/auto-observability': resolve(__dirname, 'src/defaults/auto-observability.ts'),
      },
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
        // 子路径外部化（如 react-dom/server, react-dom/client, @vitejs/plugin-rsc/browser）
        /^react(-dom)?(\/.*)?$/,
        /^@vitejs\/plugin-rsc(\/.*)?$/,
        // engine 自身子路径 —— auto-observability 用 dynamic import 自己的 adapters 子包
        /^@novel-isr\/engine(\/.*)?$/,
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
