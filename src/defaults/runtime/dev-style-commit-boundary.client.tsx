'use client';

import * as React from 'react';

import { commitDevStyleTree } from './dev-style-navigation.client';

interface DevStyleCommitBoundaryProps {
  children: React.ReactNode;
  generation: number;
}

export function DevStyleCommitBoundary({
  children,
  generation,
}: DevStyleCommitBoundaryProps): React.ReactNode {
  React.useLayoutEffect(() => commitDevStyleTree(generation), [generation]);
  return children;
}
