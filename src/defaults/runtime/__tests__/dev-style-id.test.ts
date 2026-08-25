import { describe, expect, it } from 'vitest';

import { canonicalizeDevStyleId, styleIdsMatch } from '../dev-style-id';

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
});
