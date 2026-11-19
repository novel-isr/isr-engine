/**
 * Bench app 的 Vite 配置 —— 用 engine 自家的 createIsrPlugin
 * 确保 bench 测的是 engine 真实的中间件链路（plugin-rsc + ISR cache + RSC 三环境），
 * 而不是某个简化版的 mock 服务器。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { createIsrPlugin } from 'isr-engine';

// Historical releases may have a different package identity. Resolve their generated
// self-imports through the same installed artifact used by this benchmark fixture.
const require = createRequire(import.meta.url);
const installedName: string = JSON.parse(
  readFileSync(require.resolve('isr-engine/package.json'), 'utf8')
).name;

export default defineConfig({
  resolve: {
    alias:
      installedName === 'isr-engine' ? [] : [{ find: installedName, replacement: 'isr-engine' }],
  },
  plugins: [...createIsrPlugin()],
  build: {
    minify: false, // bench 关心稳定性 > 体积；不 minify 让栈跟踪更可读
    sourcemap: true,
  },
});
