import { getI18nLocale } from 'isr-engine/rsc';
import { withLocale, type PageProps } from 'isr-engine/runtime';
import config from '../ssr.config';
import ProductionView from './view.client';

export function seo({ pathname }: PageProps) {
  return pathname === '/article' ? { canonical: pathname } : null;
}

export default function Page({ pathname }: PageProps) {
  const i18n = config.runtime.i18n;
  const locale = getI18nLocale(i18n.defaultLocale);
  const article = pathname === '/article';
  const destination = withLocale(article ? '/' : '/article', locale, i18n);
  return <ProductionView route={article ? 'Article' : 'Home'} destination={destination} />;
}
