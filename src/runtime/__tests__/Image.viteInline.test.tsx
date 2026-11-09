import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Image } from '../Image';

it('renders a default Vite-inlined PNG directly with priority and no optimizer candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isr-inline-image-'));
  try {
    await writeFile(
      join(root, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=',
        'base64'
      )
    );
    await writeFile(join(root, 'entry.js'), "export { default as src } from './pixel.png';");
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        write: false,
        rollupOptions: {
          input: join(root, 'entry.js'),
          preserveEntrySignatures: 'strict',
          output: { format: 'es' },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result))
      throw new Error('Expected one build output');
    const entry = result.output.find(output => output.type === 'chunk' && output.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Missing entry chunk');
    const url = `data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`;
    const { src } = await import(/* @vite-ignore */ url);
    expect(src).toMatch(/^data:image\/png;base64,/);
    const html = renderToStaticMarkup(
      Image({ src, alt: 'pixel', width: 1, height: 1, priority: true })
    );
    expect(html).toContain(`src="${src}"`);
    expect(html).not.toContain('/_/img');
    expect(html).not.toMatch(/srcset=/i);
    expect(html).toContain('loading="eager"');
    expect(html).toMatch(/fetchPriority="high"/i);
    expect(html).toContain(`href="${src}"`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
