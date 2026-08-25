'use client';

import * as React from 'react';

// @ts-expect-error - supplied by createDevCssLifecyclePlugins during development
import { devStyleRegistry } from 'virtual:novel-isr/dev-style-registry';

export default function DevCssLifecycleBoundary() {
  React.useLayoutEffect(() => devStyleRegistry.reconcileDocumentStyles());
  return null;
}
