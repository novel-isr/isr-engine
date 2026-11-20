import type { PageProps } from 'isr-engine/runtime';
import ProductionView from './view.client';

export default function Page({ pathname }: PageProps) {
  return <ProductionView route={pathname === '/article' ? 'Article' : 'Home'} />;
}
