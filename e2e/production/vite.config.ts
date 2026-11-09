import { createIsrPlugin } from '@novel-isr/engine';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [...createIsrPlugin()],
});
