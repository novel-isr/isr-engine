import { defineConfig } from 'vite';
import { createIsrPlugin } from 'isr-engine';

export default defineConfig({
  plugins: [...createIsrPlugin()],
});
