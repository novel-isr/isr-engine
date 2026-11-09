import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import type { ISRConfig } from '../types';
import { loadConfig } from '../config/loadConfig';
import { resolveImageOptions } from '../config/resolveImageOptions';
import { createImagePlugin } from './createImagePlugin';

export function createAutomaticImagePlugin(root: string, inlineConfig: Partial<ISRConfig>): Plugin {
  let image: Plugin | undefined;
  return {
    name: 'novel-isr:automatic-images',
    async configResolved(config) {
      // An explicitly installed image plugin owns the endpoint and its own options.
      if (config.plugins.some(plugin => plugin.name === 'novel-isr:image-optimization')) return;
      const application = Object.keys(inlineConfig).length
        ? inlineConfig
        : await loadConfig({ cwd: root });
      image = createImagePlugin(resolveImageOptions(application.runtime?.images));
      const hook = image.configResolved;
      if (typeof hook === 'function') await hook.call(this, config);
    },
    configureServer(server: ViteDevServer) {
      const hook = image?.configureServer;
      if (typeof hook === 'function') return hook.call(this, server);
    },
    configurePreviewServer(server: PreviewServer) {
      const hook = image?.configurePreviewServer;
      if (typeof hook === 'function') return hook.call(this, server);
    },
  };
}
