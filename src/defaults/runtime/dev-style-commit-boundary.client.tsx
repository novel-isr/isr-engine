'use client';

import * as React from 'react';

import { commitDevStyleTree } from './dev-style-navigation.client';

interface DevStyleCommitBoundaryProps {
  children: React.ReactNode;
  generation: number;
  styleIds: string[];
}

export function DevStyleCommitBoundary({
  children,
  generation,
  styleIds,
}: DevStyleCommitBoundaryProps): React.ReactNode {
  React.useLayoutEffect(() => commitDevStyleTree(generation, styleIds), [generation, styleIds]);
  return children;
}
