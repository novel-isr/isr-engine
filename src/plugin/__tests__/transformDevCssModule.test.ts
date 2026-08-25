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

const VITE_BUNDLED_WRAPPER = `
const { updateStyle: __vite__updateStyle, removeStyle: __vite__removeStyle } = import.meta.hot._internal;
const __vite__id = "/src/Card.module.scss";
const __vite__css = ".card{color:green}";
__vite__updateStyle(__vite__id, __vite__css);
import.meta.hot.prune(() => __vite__removeStyle(__vite__id));
export default { card: "_card_123" };
`;

describe('transformDevCssModule', () => {
  it('publishes and prunes the exact browser module URL supplied by Vite', () => {
    const result = transformDevCssModule(
      VITE_WRAPPER,
      '/workspace/app/src/Card.module.scss',
      'virtual:novel-isr/dev-style-registry',
      '/src/Card.module.scss'
    );

    expect(result?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Card.module.scss", __vite__css);'
    );
    expect(result?.code).toContain(
      'import.meta.hot.prune(() => __novel_isr_dev_styles.prune("/src/Card.module.scss"));'
    );
    expect(result?.code).not.toContain('__novel_isr_dev_styles.publish(__vite__id');
  });

  it('rejects a mutator-bearing wrapper without an exact browser module mapping', () => {
    expect(() =>
      transformDevCssModule(
        VITE_WRAPPER,
        '/workspace/unknown/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/missing an exact browser module URL from the Vite module graph/i);
  });

  it('rejects a wrapper whose resolved stylesheet identity disagrees with the transformed id', () => {
    expect(() =>
      transformDevCssModule(
        VITE_WRAPPER.replace('"/src/Card.module.scss"', '"/src/a%3Fb.scss"'),
        '/src/a?b.scss',
        'virtual:novel-isr/dev-style-registry',
        '/src/a?b.scss'
      )
    ).toThrow(/stylesheet (?:identity|semantic query).*does not match/i);
  });

  it.each(['/src/Card.css', '/src/Card.scss', '/src/Card.module.scss'])(
    'routes Vite DOM mutations for %s through the development style registry',
    id => {
      const result = transformDevCssModule(
        VITE_WRAPPER.replaceAll('/src/Card.module.scss', id),
        id,
        'virtual:novel-isr/dev-style-registry'
      );

      expect(result?.code).toContain(
        'import { devStyleRegistry as __novel_isr_dev_styles } from "virtual:novel-isr/dev-style-registry";'
      );
      expect(result?.code).toContain(
        `__novel_isr_dev_styles.publish(${JSON.stringify(id)}, __vite__css);`
      );
      expect(result?.code).toContain(
        `import.meta.hot.prune(() => __novel_isr_dev_styles.prune(${JSON.stringify(id)}));`
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

    expect(result?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Card.module.scss", __vite__css);'
    );
    expect(result?.code).toContain('__novel_isr_dev_styles.prune("/src/Card.module.scss")');
    expect(result?.code).not.toContain('applyStyle(__vite__id, __vite__css)');
    expect(result?.code).not.toContain('disposeStyle(__vite__id)');
  });

  it('recognizes Vite client imports under an arbitrary configured base path', () => {
    const result = transformDevCssModule(
      VITE_WRAPPER.replace('"/@vite/client"', '"/app/@vite/client"'),
      '/src/Card.module.scss',
      'virtual:novel-isr/dev-style-registry'
    );

    expect(result?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Card.module.scss", __vite__css);'
    );
    expect(result?.code).toContain('__novel_isr_dev_styles.prune("/src/Card.module.scss")');
  });

  it.each([
    [
      'dot-property access',
      'viteClient.updateStyle("/src/Card.module.scss", ".card{color:green}");',
    ],
    [
      'computed-property access',
      'viteClient["updateStyle"]("/src/Card.module.scss", ".card{color:green}");',
    ],
  ])('rejects namespace Vite client imports with %s', (_description, mutatorCall) => {
    expect(() =>
      transformDevCssModule(
        `
          import * as viteClient from "/app/@vite/client";
          ${mutatorCall}
        `,
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });

  it('rejects a canonical wrapper with additional namespace mutator accesses', () => {
    expect(() =>
      transformDevCssModule(
        `
          import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "/app/@vite/client";
          import * as viteClient from "/app/@vite/client";
          const __vite__id = "/src/Card.module.scss";
          const __vite__css = ".card{color:green}";
          __vite__updateStyle(__vite__id, __vite__css);
          import.meta.hot.prune(() => __vite__removeStyle(__vite__id));
          viteClient.updateStyle(__vite__id, ".extra{color:red}");
          import.meta.hot.accept(() => viteClient.removeStyle(__vite__id));
          export default { card: "_card_123" };
        `,
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });

  it('routes Vite bundled-development wrappers through the registry', () => {
    const result = transformDevCssModule(
      VITE_BUNDLED_WRAPPER,
      '/src/Card.module.scss',
      'virtual:novel-isr/dev-style-registry'
    );

    expect(result?.code).toContain(
      '__novel_isr_dev_styles.publish("/src/Card.module.scss", __vite__css);'
    );
    expect(result?.code).toContain('__novel_isr_dev_styles.prune("/src/Card.module.scss")');
  });

  it('rejects unsupported Vite bundled-development mutator access', () => {
    expect(() =>
      transformDevCssModule(
        `
          const mutators = import.meta.hot._internal;
          mutators.updateStyle("/src/Card.module.scss", ".card{color:green}");
        `,
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });

  it.each([
    [
      'computed internal destructuring',
      `
        const { updateStyle: __vite__updateStyle, removeStyle: __vite__removeStyle } = import.meta.hot["_internal"];
        __vite__updateStyle("/src/Card.module.scss", ".card{color:green}");
        import.meta.hot.prune(() => __vite__removeStyle("/src/Card.module.scss"));
      `,
    ],
    [
      'direct computed internal mutator access',
      'import.meta.hot["_internal"].updateStyle("/src/Card.module.scss", ".card{color:green}");',
    ],
  ])('rejects %s', (_description, code) => {
    expect(() =>
      transformDevCssModule(code, '/src/Card.module.scss', 'virtual:novel-isr/dev-style-registry')
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });

  it('rejects a bundled wrapper that leaves an additional internal mutator call executable', () => {
    expect(() =>
      transformDevCssModule(
        `${VITE_BUNDLED_WRAPPER}\nimport.meta.hot._internal.updateStyle(__vite__id, ".extra{color:red}");`,
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });

  it('rejects a canonical bundled wrapper with additional computed internal mutator access', () => {
    expect(() =>
      transformDevCssModule(
        `${VITE_BUNDLED_WRAPPER}\nimport.meta.hot["_internal"].removeStyle(__vite__id);`,
        '/src/Card.module.scss',
        'virtual:novel-isr/dev-style-registry'
      )
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
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

  it.each([
    [
      'an extra top-level updateStyle call',
      VITE_WRAPPER.replace(
        'import.meta.hot.prune(() => __vite__removeStyle(__vite__id));',
        '__vite__updateStyle(__vite__id, ".extra{color:red}");\nimport.meta.hot.prune(() => __vite__removeStyle(__vite__id));'
      ),
    ],
    [
      'a nested removeStyle call',
      `${VITE_WRAPPER}\nfunction removeUnexpectedStyle() { __vite__removeStyle(__vite__id); }`,
    ],
    [
      'a removeStyle call outside the prune callback',
      `${VITE_WRAPPER}\nimport.meta.hot.accept(() => __vite__removeStyle(__vite__id));`,
    ],
  ])('rejects wrappers with %s', (_description, code) => {
    expect(() =>
      transformDevCssModule(code, '/src/Card.module.scss', 'virtual:novel-isr/dev-style-registry')
    ).toThrow(/Vite development CSS wrapper compatibility error.*\/src\/Card\.module\.scss/);
  });
});
