import { describe, expect, it } from 'vitest';

import {
  canonicalizeDevStyleId,
  getDevStyleTransportGeneration,
  styleIdsMatch,
  withDevStyleTransportGeneration,
} from '../dev-style-id';

describe('development stylesheet identifiers', () => {
  it('removes transport-only query parameters while preserving semantic parameters', () => {
    expect(canonicalizeDevStyleId('/src/Card.scss?direct&t=42')).toBe('/src/Card.scss');
    expect(canonicalizeDevStyleId('http://localhost:3000/src/Card.scss?direct')).toBe(
      '/src/Card.scss'
    );
    expect(canonicalizeDevStyleId('/src/Card.scss?theme=dark&direct')).toBe(
      '/src/Card.scss?theme=dark'
    );
  });

  it('matches Vite filesystem identities with client stylesheet URLs', () => {
    expect(styleIdsMatch('/workspace/app/src/Card.scss', '/src/Card.scss?direct')).toBe(true);
  });

  it('keeps the generation as transport metadata but removes it from canonical ownership', () => {
    const transport = withDevStyleTransportGeneration('/src/Card.scss?direct&theme=dark', 7);

    expect(transport).toBe('/src/Card.scss?direct=&theme=dark&__novel_isr_style_generation=7');
    expect(getDevStyleTransportGeneration(transport)).toBe(7);
    expect(canonicalizeDevStyleId(transport)).toBe('/src/Card.scss?theme=dark');
    expect(getDevStyleTransportGeneration('/src/Card.scss?direct')).toBeUndefined();
  });
});
