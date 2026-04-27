/**
 * Bench fixture 的 Vite 配置 —— 用 engine 自家的 createIsrPlugin
 * 确保 bench 测的是 engine 真实的中间件链路（plugin-rsc + ISR cache + RSC 三环境），
 * 而不是某个简化版的 mock 服务器。
 */
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';

export default defineConfig({
  plugins: [...createIsrPlugin()],
  build: {
    minify: false, // bench 关心稳定性 > 体积；不 minify 让栈跟踪更可读
    sourcemap: true,
  },
});
