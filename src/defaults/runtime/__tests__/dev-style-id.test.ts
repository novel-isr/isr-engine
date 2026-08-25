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

  it('matches only exact canonical browser module URLs', () => {
    expect(styleIdsMatch('/src/Card.scss', '/src/Card.scss?direct')).toBe(true);
    expect(styleIdsMatch('/@fs/workspace/package/src/Card.scss', '/src/Card.scss?direct')).toBe(
      false
    );
  });

  it('preserves encoded reserved path bytes without turning them into query syntax', () => {
    expect(canonicalizeDevStyleId('/src/a%3fb.scss')).toBe('/src/a%3Fb.scss');
    expect(canonicalizeDevStyleId('/src/a%2fb.scss')).toBe('/src/a%2Fb.scss');
    expect(canonicalizeDevStyleId('/src/a%23b.scss')).toBe('/src/a%23b.scss');
    expect(canonicalizeDevStyleId('/src/a?b.scss')).toBe('/src/a?b.scss=');
    expect(styleIdsMatch('/src/a%3Fb.scss', '/src/a?b.scss')).toBe(false);
  });

  it('normalizes percent case and semantic query order component by component', () => {
    expect(canonicalizeDevStyleId('/src/a%7eb.scss?z=%2f&a=hello%20world')).toBe(
      '/src/a~b.scss?a=hello+world&z=%2F'
    );
  });

  it('keeps the generation as transport metadata but removes it from canonical ownership', () => {
    const transport = withDevStyleTransportGeneration('/src/Card.scss?direct&theme=dark', 7);

    expect(transport).toBe('/src/Card.scss?direct=&theme=dark&__novel_isr_style_generation=7');
    expect(getDevStyleTransportGeneration(transport)).toBe(7);
    expect(canonicalizeDevStyleId(transport)).toBe('/src/Card.scss?theme=dark');
    expect(getDevStyleTransportGeneration('/src/Card.scss?direct')).toBeUndefined();
  });
});
