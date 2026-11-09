import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSsgPostBuildPlugin } from '../createSsgPostBuildPlugin';
import { clearConfigCache } from '@/config/loadConfig';

let root: string;
afterEach(async () => {
  clearConfigCache();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it.each([
  [
    "export default { renderMode:'ssr', revalidate:60, routes:{}, ssg:{routes:['/%GG']}, server:{}, runtime:{site:undefined,services:{api:undefined,telemetry:undefined},redis:undefined,experiments:{},i18n:undefined,seo:undefined,telemetry:false} };",
    /Invalid HTML route/,
  ],
  ["throw new Error('config evaluation failed');", /config evaluation failed/],
])('never publishes a manifest after configuration failure', async (source, reason) => {
  clearConfigCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssg-config-'));
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(root, 'ssr.config.mjs'), source);
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    'export default {fetch:async()=>new Response("unused")};'
  );
  const plugin = createSsgPostBuildPlugin(undefined);
  const resolved = plugin.configResolved;
  if (typeof resolved !== 'function') throw new Error('Missing configuration hook');
  await resolved.call({} as never, { root } as never);
  const hook = plugin.buildApp;
  if (!hook) throw new Error('Missing build hook');
  const run = typeof hook === 'function' ? hook : hook.handler;
  await expect(run.call({} as never, {} as never)).rejects.toThrow(reason);
  await expect(fs.access(path.join(root, 'dist/static-csp-manifest.json'))).rejects.toThrow();
});
