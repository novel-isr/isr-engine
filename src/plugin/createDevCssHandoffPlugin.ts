import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Plugin } from 'vite';

export const VITE_RSC_REMOVE_DUPLICATE_CSS_ID = 'virtual:vite-rsc/remove-duplicate-server-css';
export const DEV_CSS_HANDOFF_RESOLVED_ID = '\0virtual:novel-isr/dev-css-handoff';

export function createDevCssHandoffPlugin(defaultsDir: string): Plugin {
  const helperUrl = pathToFileURL(
    path.resolve(defaultsDir, 'runtime/dev-css-handoff.client.ts')
  ).href;

  return {
    name: 'isr:dev-css-handoff',
    apply: 'serve',
    enforce: 'pre',
    resolveId(id) {
      if (id === VITE_RSC_REMOVE_DUPLICATE_CSS_ID) return DEV_CSS_HANDOFF_RESOLVED_ID;
      return undefined;
    },
    load(id) {
      if (id !== DEV_CSS_HANDOFF_RESOLVED_ID) return undefined;
      return `
        "use client";
        import * as React from "react";
        import { handoffDevClientReferenceStyles } from ${JSON.stringify(helperUrl)};

        export default function DevCssHandoff() {
          React.useEffect(() => handoffDevClientReferenceStyles(), []);
          return null;
        }
      `;
    },
  };
}
