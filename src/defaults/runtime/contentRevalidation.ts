/** Data and response cache scopes to invalidate after a content write commits. */
export interface ContentRevalidationOptions {
  /** Exact site paths, including any locale prefix. */
  paths?: readonly string[];
  /** Business pathnames expanded using the runtime's routing config and the supplied locales. */
  localizedPaths?: readonly string[];
  tags?: readonly string[];
  locales?: readonly string[];
  sitemap?: boolean;
}

export interface ContentPublication {
  id: string;
  scopes: Readonly<Omit<Required<ContentRevalidationOptions>, 'localizedPaths'>>;
}

type ContentInvalidation = ContentPublication['scopes'] & { allPageMetadata?: true };
type ContentInvalidator = (scopes: ContentInvalidation) => void;

// Node, the RSC bundle, and the published site-hooks entry have separate module graphs.
const KEY = Symbol.for('isr-engine:content-invalidators');
const runtime = globalThis as typeof globalThis & {
  [KEY]?: Set<ContentInvalidator | WeakRef<ContentInvalidator>>;
};

export function registerContentInvalidator(
  invalidate: ContentInvalidator,
  { weak = false } = {}
): () => void {
  const registry = (runtime[KEY] ??= new Set());
  for (const entry of registry) {
    if (typeof entry !== 'function' && !entry.deref()) registry.delete(entry);
  }
  const entry = weak ? new WeakRef(invalidate) : invalidate;
  registry.add(entry);
  return () => {
    registry.delete(entry);
  };
}

/** The default scope recovers page metadata after a missed Redis notification. */
export function invalidateContentCaches(
  scopes: ContentInvalidation = {
    paths: [],
    tags: [],
    locales: [],
    sitemap: false,
    allPageMetadata: true,
  }
): void {
  const errors: unknown[] = [];
  const registry = runtime[KEY];
  if (!registry) return;
  for (const entry of registry) {
    const invalidate = typeof entry === 'function' ? entry : entry.deref();
    if (!invalidate) {
      registry.delete(entry);
      continue;
    }
    try {
      invalidate(scopes);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Content metadata invalidation failed');
}

export function normalizeContentScopes(
  input: unknown
): ContentPublication['scopes'] & Pick<ContentRevalidationOptions, 'localizedPaths'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid content revalidation scopes');
  }
  const { paths, localizedPaths, tags, locales, sitemap } = input as ContentRevalidationOptions;
  function read(values: unknown): string[] {
    if (values === undefined) return [];
    if (
      !Array.isArray(values) ||
      Array.from(values).some(value => typeof value !== 'string' || !value.trim())
    ) {
      throw new TypeError('Content revalidation scopes must contain non-empty strings');
    }
    return values;
  }
  if (sitemap !== undefined && typeof sitemap !== 'boolean') {
    throw new TypeError('Content revalidation sitemap must be a boolean');
  }
  return {
    paths: [...new Set(read(paths))],
    ...(localizedPaths !== undefined && { localizedPaths: [...new Set(read(localizedPaths))] }),
    tags: [...new Set(read(tags))],
    locales: [...new Set(read(locales).map(locale => locale.trim().toLowerCase()))],
    sitemap: sitemap ?? false,
  };
}
