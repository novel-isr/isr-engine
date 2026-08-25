import { describe, expect, it } from 'vitest';

import {
  declareDevClientReferenceStyles,
  declareDevStyleDependencies,
  registerDevClientReferenceStyles,
  runWithDevStyleDeclarationCollection,
} from '../dev-style-declarations.server';

describe('development RSC style declarations', () => {
  it('collects a canonical, request-scoped style set', () => {
    const styleIds: string[] = [];

    runWithDevStyleDeclarationCollection(styleIds, () => {
      declareDevStyleDependencies({ css: ['/src/A.scss?direct&t=42'], js: [] });
      declareDevStyleDependencies({ css: ['/src/A.scss?v=43', '/src/B.css?direct'], js: [] });
    });

    expect(styleIds).toEqual(['/src/A.scss', '/src/B.css']);
  });

  it('rejects an unknown plugin-rsc dependency callback shape', () => {
    expect(() =>
      runWithDevStyleDeclarationCollection([], () =>
        declareDevStyleDependencies({ stylesheets: ['/src/A.scss'] })
      )
    ).toThrow(/unsupported @vitejs\/plugin-rsc dependency shape/i);
  });

  it('combines upstream and engine-mapped client-reference styles in the request scope', () => {
    registerDevClientReferenceStyles('/src/ClientCard.tsx', ['/src/ClientCard.module.scss?direct']);
    const styleIds: string[] = [];

    runWithDevStyleDeclarationCollection(styleIds, () => {
      declareDevClientReferenceStyles({
        id: '/src/ClientCard.tsx',
        deps: { css: ['/src/shared.css?direct'], js: [] },
      });
    });

    expect(styleIds).toEqual(['/src/shared.css', '/src/ClientCard.module.scss']);
  });

  it('fails explicitly when a development client reference has no engine mapping', () => {
    expect(() =>
      runWithDevStyleDeclarationCollection([], () =>
        declareDevClientReferenceStyles({ id: '/src/Unknown.tsx', deps: { css: [], js: [] } })
      )
    ).toThrow(/missing development stylesheet mapping.*Unknown\.tsx/i);
  });
});
