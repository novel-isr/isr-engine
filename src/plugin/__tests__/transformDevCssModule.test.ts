import { describe, expect, it } from 'vitest';

import { transformDevCssModule } from '../transformDevCssModule';

const VITE_WRAPPER = `
import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "/@vite/client";
const __vite__id = "/src/Card.module.scss";
const __vite__css = ".card{color:green}";
__vite__updateStyle(__vite__id, __vite__css);
import.meta.hot.prune(() => __vite__removeStyle(__vite__id));
export default { card: "_card_123" };
`;

describe('transformDevCssModule', () => {
  it.each(['/src/Card.css', '/src/Card.scss', '/src/Card.module.scss'])(
    'routes Vite DOM mutations for %s through the development style registry',
    id => {
      const result = transformDevCssModule(
        VITE_WRAPPER,
        id,
        'virtual:novel-isr/dev-style-registry'
      );

      expect(result?.code).toContain(
        'import { devStyleRegistry as __novel_isr_dev_styles } from "virtual:novel-isr/dev-style-registry";'
      );
      expect(result?.code).toContain('__novel_isr_dev_styles.publish(__vite__id, __vite__css);');
      expect(result?.code).toContain(
        'import.meta.hot.prune(() => __novel_isr_dev_styles.prune(__vite__id));'
      );
      expect(result?.code).toContain('export default { card: "_card_123" };');
      expect(result?.code).not.toContain('__vite__updateStyle(__vite__id, __vite__css)');
      expect(result?.code).not.toContain('__vite__removeStyle(__vite__id)');
      expect(result?.map).toBeNull();
    }
  );

  it('preserves aliased Vite DOM mutator bindings while replacing their calls', () => {
    const result = transformDevCssModule(
      VITE_WRAPPER.replace(/__vite__updateStyle/g, 'applyStyle').replace(
        /__vite__removeStyle/g,
        'disposeStyle'
      ),
      '/src/Card.module.scss',
      'virtual:novel-isr/dev-style-registry'
    );

    expect(result?.code).toContain('__novel_isr_dev_styles.publish(__vite__id, __vite__css);');
    expect(result?.code).toContain('__novel_isr_dev_styles.prune(__vite__id)');
    expect(result?.code).not.toContain('applyStyle(__vite__id, __vite__css)');
    expect(result?.code).not.toContain('disposeStyle(__vite__id)');
  });

  it('does not transform direct stylesheet resources', () => {
    expect(
      transformDevCssModule(
        VITE_WRAPPER,
        '/src/Card.module.scss?direct',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toBeUndefined();
  });

  it('does not transform unrelated JavaScript modules', () => {
    expect(
      transformDevCssModule(VITE_WRAPPER, '/src/Card.tsx', 'virtual:novel-isr/dev-style-registry')
    ).toBeUndefined();
  });

  it('does not reject stylesheet transform stages with no Vite wrapper evidence', () => {
    expect(
      transformDevCssModule(
        'export default { card: "_card_123" };',
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toBeUndefined();
  });

  it('throws a development compatibility error for incomplete Vite stylesheet wrappers', () => {
    expect(() =>
      transformDevCssModule(
        VITE_WRAPPER.replace('import.meta.hot.prune(() => __vite__removeStyle(__vite__id));', ''),
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });
});
