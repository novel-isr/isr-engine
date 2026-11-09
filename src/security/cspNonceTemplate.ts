/** JSON-safe metadata recorded once alongside the canonical cached response bytes. */
export interface CspNonceTemplate {
  nonce: string;
  offsets: number[];
}

const NONCE_VALUE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const NONCE_SOURCE = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/i;

/** Compile all verbatim nonce occurrences, including HTML attributes and serialized JS. */
export function compileCspNonceTemplate(
  policy: string | undefined,
  body: Buffer
): CspNonceTemplate | undefined {
  if (!policy) return undefined;
  const nonces = new Set<string>();
  for (const token of policy.split(/[\s;,]+/)) {
    const match = NONCE_SOURCE.exec(token);
    if (match) nonces.add(match[1]);
  }
  if (nonces.size === 0) return undefined;
  if (nonces.size !== 1)
    throw new Error('Cannot compile a CSP template with multiple source nonces');
  const nonce = [...nonces][0];
  const source = Buffer.from(nonce, 'ascii');
  const offsets: number[] = [];
  for (
    let offset = body.indexOf(source);
    offset !== -1;
    offset = body.indexOf(source, offset + source.length)
  ) {
    offsets.push(offset);
  }
  return offsets.length ? { nonce, offsets } : undefined;
}

/** Instantiate without parsing HTML or modifying the shared cached response buffer. */
export function instantiateCspNonceTemplate(
  body: Buffer,
  template: CspNonceTemplate,
  nonce: string
): Buffer {
  if (
    !template ||
    typeof template !== 'object' ||
    typeof template.nonce !== 'string' ||
    !NONCE_VALUE.test(template.nonce) ||
    !Array.isArray(template.offsets) ||
    template.offsets.length === 0
  ) {
    throw new Error('Invalid cached CSP nonce template');
  }
  if (typeof nonce !== 'string' || !NONCE_VALUE.test(nonce))
    throw new Error('Invalid replacement CSP nonce');
  const source = Buffer.from(template.nonce, 'ascii');
  const replacement = Buffer.from(nonce, 'ascii');
  const fragments: Buffer[] = [];
  let cursor = 0;
  for (const offset of template.offsets) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < cursor ||
      offset + source.length > body.length ||
      !body.subarray(offset, offset + source.length).equals(source)
    ) {
      throw new Error('Cached CSP nonce template does not match response bytes');
    }
    fragments.push(body.subarray(cursor, offset), replacement);
    cursor = offset + source.length;
  }
  fragments.push(body.subarray(cursor));
  return Buffer.concat(fragments);
}
