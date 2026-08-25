import { describe, expect, it } from 'vitest';

import {
  declareDevClientReferenceStyles,
  declareDevStyleDependencies,
  prepareDevStyleDependencies,
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

  it('delegates generation-bound importer CSS to resource transport while collecting canonical ids', () => {
    const styleIds: string[] = [];
    let prepared: unknown;

    runWithDevStyleDeclarationCollection(
      styleIds,
      () => {
        prepared = prepareDevStyleDependencies({
          css: ['/src/A.scss?direct', '/src/B.css?theme=dark&direct'],
          js: ['/src/chunk.js'],
        });
      },
      { transportGeneration: 4 }
    );

    expect(prepared).toEqual({
      css: [],
      js: ['/src/chunk.js'],
    });
    expect(styleIds).toEqual(['/src/A.scss', '/src/B.css?theme=dark']);
  });

  it('does not retain generation-bound importer CSS as preload-only resource children', () => {
    const styleIds: string[] = [];
    let prepared: unknown;
    runWithDevStyleDeclarationCollection(
      styleIds,
      () => {
        prepared = prepareDevStyleDependencies({
          css: ['/src/A.scss?z=2&direct&a=1&t=old'],
          js: [],
        });
      },
      { transportGeneration: 5 }
    );

    expect(prepared).toEqual({
      css: [],
      js: [],
    });
    expect(styleIds).toEqual(['/src/A.scss?a=1&z=2']);
  });

  it('does not add a transport generation outside a development navigation request', () => {
    let prepared: unknown;

    runWithDevStyleDeclarationCollection([], () => {
      prepared = prepareDevStyleDependencies({ css: ['/src/A.scss?direct'], js: [] });
    });

    expect(prepared).toEqual({ css: ['/src/A.scss?direct'], js: [] });
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
