/**
 * RSC / Flight 协议相关常量
 */

export const SERVER_ACTION_ENDPOINT = '/_rsc/action';
export const LEGACY_SERVER_ACTION_ENDPOINT = '/api/server-actions';
export const SERVER_ACTION_ENDPOINTS = [SERVER_ACTION_ENDPOINT, LEGACY_SERVER_ACTION_ENDPOINT];

export function getServerActionEndpointCandidates(primaryEndpoint?: string): string[] {
  const candidates = new Set<string>();
  const endpoint = primaryEndpoint || SERVER_ACTION_ENDPOINT;

  candidates.add(endpoint);
  candidates.add(SERVER_ACTION_ENDPOINT);
  candidates.add(LEGACY_SERVER_ACTION_ENDPOINT);

  return Array.from(candidates);
}

export function isLegacyServerActionEndpoint(endpoint: string): boolean {
  return endpoint === LEGACY_SERVER_ACTION_ENDPOINT;
}

export function shouldSkipServerActionEndpointRetry(endpoint: string): boolean {
  return isLegacyServerActionEndpoint(endpoint);
}
