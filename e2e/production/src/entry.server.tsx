/** A real per-request script reference to exercise cached nonce instantiation. */
export default {
  headExtras: ({ nonce }: { nonce?: string }) =>
    nonce
      ? `<script nonce="${nonce}">window.__nonceReference=${JSON.stringify(nonce)};</script>`
      : undefined,
};
