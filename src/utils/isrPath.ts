export const RSC_URL_POSTFIX = '_.rsc';

export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export function stripRscSuffix(path: string): string {
  if (path.endsWith(`/${RSC_URL_POSTFIX}`)) {
    return path.slice(0, -(RSC_URL_POSTFIX.length + 1)) || '/';
  }
  if (path.endsWith(RSC_URL_POSTFIX)) {
    return path.slice(0, -RSC_URL_POSTFIX.length) || '/';
  }
  return path;
}

export function normalizePath(path: string): string {
  return path.startsWith('/') ? path : '/' + path;
}

export function contentPathname(path: string): string {
  return stripRscSuffix(normalizePath(stripQuery(path)));
}
