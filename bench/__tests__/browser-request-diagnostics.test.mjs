import { describe, expect, it } from 'vitest';
import {
  DocumentRequestTracker,
  isExpectedRscCancellation,
} from '../../e2e/dev-css-lifecycle/request-diagnostics';

const failure = {
  url: 'http://127.0.0.1/article_.rsc',
  method: 'GET',
  resourceType: 'fetch',
  error: 'net::ERR_ABORTED',
  navigationRequest: false,
  earlierDocument: false,
};

describe('browser request document ownership', () => {
  it('recognizes the trace ordering: prefetch starts, new document navigation starts, prefetch cancels', () => {
    const tracker = new DocumentRequestTracker();
    const prefetch = {};
    tracker.observe({}, true);
    tracker.commitMainDocument();
    tracker.observe(prefetch, false);
    expect(tracker.belongsToEarlierDocument(prefetch)).toBe(false);
    tracker.observe({}, true);
    expect(
      isExpectedRscCancellation({
        ...failure,
        earlierDocument: tracker.belongsToEarlierDocument(prefetch),
      })
    ).toBe(true);
  });

  it('keeps requests from the old document in the pending reload window with their owner', () => {
    const tracker = new DocumentRequestTracker();
    tracker.observe({}, true);
    tracker.commitMainDocument();
    tracker.observe({}, true); // reload request starts before old document stops executing
    const oldPrefetch = {};
    tracker.observe(oldPrefetch, false);
    expect(tracker.belongsToEarlierDocument(oldPrefetch)).toBe(true);
    tracker.commitMainDocument(); // requestfailed can precede this commit
    expect(tracker.belongsToEarlierDocument(oldPrefetch)).toBe(true);
    const currentPrefetch = {};
    tracker.observe(currentPrefetch, false);
    expect(tracker.belongsToEarlierDocument(currentPrefetch)).toBe(false);
  });

  it('does not advance document ownership for failed navigations or history changes', () => {
    const tracker = new DocumentRequestTracker();
    tracker.observe({}, true);
    tracker.commitMainDocument();
    const navigation = {};
    const prefetch = {};
    tracker.observe(prefetch, false);
    tracker.observe(navigation, true);
    tracker.navigationFailed(navigation);
    tracker.commitMainDocument();
    expect(tracker.belongsToEarlierDocument(prefetch)).toBe(false);
  });

  it('does not make an earlier unexplained failure harmless when a later reload starts', () => {
    const tracker = new DocumentRequestTracker();
    tracker.observe({}, true);
    tracker.commitMainDocument();
    const prefetch = {};
    tracker.observe(prefetch, false);
    // Capture ownership when requestfailed fires, before any navigation starts.
    const captured = { ...failure, earlierDocument: tracker.belongsToEarlierDocument(prefetch) };
    tracker.observe({}, true);
    tracker.commitMainDocument();
    expect(isExpectedRscCancellation(captured)).toBe(false);
  });

  it('does not assign document ownership to unobserved requests', () => {
    const tracker = new DocumentRequestTracker();
    tracker.observe({}, true);
    expect(tracker.belongsToEarlierDocument({})).toBe(false);
  });

  it('does not replace the document for subresource or child-frame requests', () => {
    const tracker = new DocumentRequestTracker();
    const request = {};
    tracker.observe(request, false);
    tracker.observe({}, false);
    expect(tracker.belongsToEarlierDocument(request)).toBe(false);
  });

  it('keeps current-document speculative cancellations visible', () => {
    expect(isExpectedRscCancellation(failure)).toBe(false);
  });

  it('retains explicit navigation-generation cancellation semantics', () => {
    expect(isExpectedRscCancellation({ ...failure, navigationRequest: true })).toBe(true);
  });

  it.each([
    { resourceType: 'stylesheet' },
    { url: 'http://127.0.0.1/Home.module.scss' },
    { method: 'POST' },
    { error: 'net::ERR_FAILED' },
    { error: 'net::ERR_CONNECTION_RESET' },
    { url: 'invalid URL' },
  ])('does not suppress unrelated failures: %j', fields => {
    expect(isExpectedRscCancellation({ ...failure, earlierDocument: true, ...fields })).toBe(false);
  });
});
