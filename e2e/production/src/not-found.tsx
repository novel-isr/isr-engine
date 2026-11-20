import { getI18n } from 'isr-engine/runtime';

export function seo() {
  return { title: getI18n('notFoundTitle'), noindex: true };
}

export default function NotFound() {
  return <h1>{getI18n('notFoundTitle')}</h1>;
}
