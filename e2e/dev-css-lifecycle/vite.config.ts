import { createIsrPlugin } from 'isr-engine';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [...createIsrPlugin()],
});
