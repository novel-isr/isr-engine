import type { PageProps } from 'isr-engine/runtime';
import ProductionView from './view.client';

export function seo({ pathname }: PageProps) {
  return pathname === '/article' ? { canonical: pathname } : null;
}

export default function Page({ pathname }: PageProps) {
  return <ProductionView route={pathname === '/article' ? 'Article' : 'Home'} />;
}
