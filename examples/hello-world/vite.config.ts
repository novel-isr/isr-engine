/**
 * isr-engine 接入只需一行: 把 createIsrPlugin() 加进 plugins.
 *
 * createIsrPlugin 内部已经组装好:
 *   - @vitejs/plugin-rsc (官方 Flight 流水线 + 内置 React Refresh / JSX，无需额外装 @vitejs/plugin-react)
 *   - 默认 SSR / RSC entry 解析
 *   - ISR cache 中间件 (dev + prod)
 */
import { defineConfig } from 'vite';
import { createIsrPlugin } from '@novel-isr/engine';

export default defineConfig({
  plugins: [...createIsrPlugin()],
});
