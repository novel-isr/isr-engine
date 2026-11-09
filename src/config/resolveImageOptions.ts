/** Shared image policy for the automatic development and production endpoints. */
export function resolveImageOptions(images: unknown): { remoteAllowlist: string[] } {
  const invalid = () =>
    new Error(
      'runtime.images must contain only remoteAllowlist: an array of exact host[:port] entries'
    );
  if (images === undefined) return { remoteAllowlist: [] };
  if (typeof images !== 'object' || images === null || Array.isArray(images)) throw invalid();
  const value = images as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'remoteAllowlist')) throw invalid();
  if (value.remoteAllowlist === undefined) return { remoteAllowlist: [] };
  if (!Array.isArray(value.remoteAllowlist)) throw invalid();
  const hosts = value.remoteAllowlist.map((host: unknown) => {
    if (typeof host !== 'string' || !host || /[\s/@?#*\\]/.test(host)) throw invalid();
    let url: URL;
    try {
      url = new URL(`https://${host}`);
    } catch {
      throw invalid();
    }
    // Reject schemes, paths and URL parser repair; allow normalized case and international names.
    if (
      !url.hostname ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      host.includes('://')
    )
      throw invalid();
    const authority = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(host);
    if (!authority) throw invalid();
    // WHATWG URL drops default ports; the allowlist must retain an explicit port restriction.
    return url.hostname + (authority[2] === undefined ? '' : `:${Number(authority[2])}`);
  });
  return { remoteAllowlist: [...new Set(hosts)] };
}
