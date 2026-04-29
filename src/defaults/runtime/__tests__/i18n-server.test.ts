import { describe, expect, it } from 'vitest';

import { requestContext } from '../../../context/RequestContext';
import { getCurrentI18n, getI18n, runWithI18n } from '../i18n-server';

describe('i18n-server', () => {
  it('falls back to RequestContext intl during async RSC streaming work', async () => {
    await requestContext.run(
      {
        traceId: 't-i18n',
        requestId: 'r-i18n',
        intl: {
          locale: 'zh',
          messages: { home: { title: '首页' } },
        },
      },
      async () => {
        await Promise.resolve();
        expect(getCurrentI18n()?.locale).toBe('zh');
        expect(getI18n('home.title')).toBe('首页');
      }
    );
  });

  it('runWithI18n takes precedence over RequestContext intl', async () => {
    await requestContext.run(
      {
        traceId: 't-i18n',
        requestId: 'r-i18n',
        intl: {
          locale: 'zh',
          messages: { home: { title: '首页' } },
        },
      },
      async () => {
        await runWithI18n(
          {
            locale: 'en',
            messages: { home: { title: 'Home' } },
          },
          async () => {
            expect(getCurrentI18n()?.locale).toBe('en');
            expect(getI18n('home.title')).toBe('Home');
          }
        );
      }
    );
  });
});
