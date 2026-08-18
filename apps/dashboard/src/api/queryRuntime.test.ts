import { afterEach, describe, expect, it } from 'vitest';
import { focusManager } from '@tanstack/react-query';
import { configureQueryFocus } from './queryRuntime.js';

/**
 * The retry gate, pinned at the only place it is observable without a DOM.
 *
 * `focusManager.isFocused()` is what @tanstack/query-core's retryer consults in
 * `canContinue()` before every retry — ahead of `networkMode`, so
 * `networkMode: 'always'` does not bypass it. When it answers false a failed
 * query pauses with `fetchStatus: 'paused'`, the error is never recorded, and
 * interaction-spec.md §4's states become unreachable. `configureQueryFocus()`
 * is the one line that stops that; this file is what stops the line being
 * deleted as a no-op, because a no-op is exactly what it looks like.
 *
 * NO DOM AND NO NEW TEST DEPENDENCY — `shell/useBreakpoint.test.ts` sets that
 * constraint for this column. `isFocused()` falls back to
 * `globalThis.document?.visibilityState !== 'hidden'`, so a two-property object
 * assigned to `globalThis.document` is enough to drive it. That is also why the
 * first test matters: without the stub, `globalThis.document` is undefined in
 * node, `undefined !== 'hidden'` is true, and every assertion here would pass
 * against a deleted implementation.
 */

const realDocument = (globalThis as { document?: unknown }).document;

/** The state the automated browser pane reports permanently, and a hidden tab. */
function pretendDocumentIsHidden(): void {
  (globalThis as { document?: unknown }).document = { visibilityState: 'hidden', hidden: true };
}

function restoreDocument(): void {
  if (realDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = realDocument;
}

afterEach(() => {
  restoreDocument();
  // `setFocused(undefined)` hands control back to the visibilityState fallback,
  // so one test's override cannot decide the next one's answer.
  focusManager.setFocused(undefined);
});

describe('the focus gate this configuration exists to defeat', () => {
  it('reports NOT focused for a hidden document, which is what pauses a retry', () => {
    focusManager.setFocused(undefined);
    pretendDocumentIsHidden();
    // If this ever passes, the stub has stopped working and every other
    // assertion in this file is vacuous.
    expect(focusManager.isFocused()).toBe(false);
  });

  it('reports focused for a visible document', () => {
    focusManager.setFocused(undefined);
    (globalThis as { document?: unknown }).document = {
      visibilityState: 'visible',
      hidden: false,
    };
    expect(focusManager.isFocused()).toBe(true);
  });
});

describe('configureQueryFocus', () => {
  it('makes a hidden document report focused, so canContinue lets the retry run', () => {
    focusManager.setFocused(undefined);
    pretendDocumentIsHidden();
    expect(focusManager.isFocused()).toBe(false);

    configureQueryFocus();

    expect(focusManager.isFocused()).toBe(true);
  });

  it('survives the visibilitychange notification the library sends', () => {
    // focusManager's default listener calls `onFocus()`, which notifies
    // subscribers and does NOT reset the pinned value. If a future version
    // changed that to `setFocused(undefined)`, the override would silently
    // expire the first time a merchant switched tabs — the failure would look
    // exactly like the bug this fixes, so it is pinned here.
    pretendDocumentIsHidden();
    configureQueryFocus();

    focusManager.onFocus();

    expect(focusManager.isFocused()).toBe(true);
  });

  it('is idempotent, so calling it twice cannot toggle anything', () => {
    pretendDocumentIsHidden();
    configureQueryFocus();
    configureQueryFocus();
    expect(focusManager.isFocused()).toBe(true);
  });

  it('does not depend on a document existing at all', () => {
    // Server-rendered or test contexts have no document. The call must not throw
    // and must still pin the answer.
    delete (globalThis as { document?: unknown }).document;
    focusManager.setFocused(undefined);
    expect(() => configureQueryFocus()).not.toThrow();
    expect(focusManager.isFocused()).toBe(true);
  });
});
