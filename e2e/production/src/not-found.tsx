import { getI18n } from 'isr-engine/runtime';
import ProductionView from './view.client';

export function seo() {
  return { title: getI18n('notFoundTitle'), noindex: true };
}

export default function NotFound() {
  return <ProductionView route={getI18n('notFoundTitle')} />;
}
