/**
 * The deletion slice's two decisions, both of which are one-line mistakes with
 * consequences a customer feels:
 *
 *   which state Account's exit slot shows — get it wrong and either she cannot
 *   find the cancel door on a clock that is running, or she is told her account
 *   is scheduled for deletion when it is not;
 *
 *   which calendar day the erasure falls on, and in whose timezone.
 */

import { describe, expect, it } from 'vitest';
import { deletionSection, erasureDueOn } from './deletion';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { hasEasternDigits, hasWesternDigits } from '../i18n/digits';

describe('erasureDueOn', () => {
  it('resolves the instant in KUWAIT, not in the device zone', () => {
    // 2026-09-17T21:30Z is already the 18th in Kuwait (UTC+3). A formatter that
    // used the device zone would say the 17th to a customer in London and the
    // 18th to one in Kuwait, for the same server value.
    expect(erasureDueOn('2026-09-17T21:30:00.000Z')).toBe('2026-09-18');
  });

  it('does not roll the date backwards for a morning instant', () => {
    expect(erasureDueOn('2026-09-17T08:18:30.344Z')).toBe('2026-09-17');
  });

  it('handles the midnight-Kuwait boundary', () => {
    // 21:00Z is exactly 00:00 next day in Kuwait.
    expect(erasureDueOn('2026-09-16T21:00:00.000Z')).toBe('2026-09-17');
    expect(erasureDueOn('2026-09-16T20:59:59.000Z')).toBe('2026-09-16');
  });

  it('returns an ISO calendar date, which is what the copy modules parse', () => {
    // `formatEffectiveFrom` only formats a strict "YYYY-MM-DD" and returns
    // anything else untouched — so a different shape here would silently render
    // the raw string into the sentence.
    expect(erasureDueOn('2026-09-17T08:18:30.344Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the scheduled sentence', () => {
  it('says nothing has been deleted yet, because nothing has', () => {
    // `erasureScheduled` is false and stays false until the retention job exists.
    // The sentence must not imply the erasure is under way.
    const body = en.deleteScheduledBody('2026-09-17');
    expect(body).toContain('Nothing has been deleted yet');
    for (const wrong of ['has been removed', 'being removed', 'is being deleted']) {
      expect(body).not.toContain(wrong);
    }
  });

  it('names the date, formatted by the copy string rather than by the caller', () => {
    expect(en.deleteScheduledBody('2026-09-17')).toContain('17 September 2026');
  });

  it('offers the cancel door in the same breath', () => {
    expect(en.deleteScheduledBody('2026-09-17')).toContain('cancel');
  });

  it('keeps one digit script per sentence — the staleBanner rule', () => {
    // Arabic is still an AR_GAP here, so the sentence is English and its digits
    // must stay Western. A caller that formatted the date in the app's language
    // would produce "…until ١٧ سبتمبر ٢٠٢٦." inside English text, which reads as
    // a bug in both languages.
    const arBody = ar.deleteScheduledBody('2026-09-17');
    expect(arBody).toBe(en.deleteScheduledBody('2026-09-17'));
    expect(hasEasternDigits(arBody)).toBe(false);
    expect(hasWesternDigits(arBody)).toBe(true);
  });
});

// ------------------------------------------------------ which state is shown --

/** `GET /members/me/deletion` while a deletion is scheduled. */
const PENDING = {
  status: 'pending' as const,
  erasureDueAt: '2026-09-17T08:18:30.344Z',
  graceDays: 30,
};

/** The same endpoint with nothing scheduled. */
const NONE = { status: 'none' as const, erasureDueAt: null, graceDays: 30 };

describe('deletionSection', () => {
  it('shows the scheduled card when the server says pending', () => {
    expect(deletionSection({ loaded: true, loadFailed: false, state: PENDING })).toEqual({
      kind: 'scheduled',
      erasureDueAt: '2026-09-17T08:18:30.344Z',
      graceDays: 30,
    });
  });

  it('shows the ordinary row when the server says none', () => {
    expect(deletionSection({ loaded: true, loadFailed: false, state: NONE })).toEqual({
      kind: 'offer',
    });
  });

  it('shows NOTHING before the server answers, rather than guessing a state', () => {
    expect(deletionSection({ loaded: false, loadFailed: false, state: null })).toEqual({
      kind: 'unknown',
    });
  });

  it('NEVER offers deletion when the read failed — the bug this slice fixes', () => {
    // `offer` is a statement that nothing is scheduled. On a failed read that
    // statement may be false, and if it is, she is looking at a running clock
    // with no sign of it and no route to the cancel door.
    const view = deletionSection({ loaded: true, loadFailed: true, state: null });
    expect(view.kind).toBe('failed');
    expect(view.kind).not.toBe('offer');
  });

  it('does not claim a deletion is scheduled when the read failed either', () => {
    // The opposite lie: telling her the account is going away when it is not.
    expect(deletionSection({ loaded: true, loadFailed: true, state: null }).kind).not.toBe(
      'scheduled',
    );
  });

  it('treats a loaded-but-absent state as unknown, not as none', () => {
    // The fall-through that would quietly re-create the bug: loaded true,
    // loadFailed false, but no state. Same epistemic position as a failure.
    expect(deletionSection({ loaded: true, loadFailed: false, state: null })).toEqual({
      kind: 'failed',
    });
  });

  it('a failed read outranks a stale pending state it may still be holding', () => {
    // If a reload fails while a pending state is in hand, the honest answer is
    // still "we could not check" — the request may have been cancelled elsewhere.
    expect(deletionSection({ loaded: true, loadFailed: true, state: PENDING }).kind).toBe('failed');
  });

  it('passes the erasure date through untouched for the card to format', () => {
    const view = deletionSection({ loaded: true, loadFailed: false, state: PENDING });
    // Not pre-formatted, and not derived from requestedAt + graceDays.
    expect(view.kind === 'scheduled' && view.erasureDueAt).toBe('2026-09-17T08:18:30.344Z');
  });

  it('survives a pending state with no due date rather than inventing one', () => {
    const view = deletionSection({
      loaded: true,
      loadFailed: false,
      state: { status: 'pending', erasureDueAt: null, graceDays: 30 },
    });
    expect(view).toEqual({ kind: 'scheduled', erasureDueAt: null, graceDays: 30 });
  });
});
