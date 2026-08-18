/**
 * The erasure due date, resolved once and in one place.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN `domain/` AND NOT BESIDE THE COMPONENT THAT USES IT.
 *
 * It started in `components/account/DeletionScheduled.tsx` and could not be
 * tested there: a `.tsx` imports `react-native`, whose source is Flow-typed, and
 * the wallet's vitest runs in a node environment with no renderer — so importing
 * the component pulls Flow syntax into Rollup and the suite fails to parse
 * before it runs a single assertion ("Expected 'from', got 'typeOf'").
 *
 * That is the reason `vitest.config.ts` says what it says. A pure function about
 * dates has no business behind that wall, and this one carries two decisions
 * worth pinning with tests.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** The salon's zone. Every date this app renders is resolved in it. */
const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

/**
 * `erasureDueAt` (an instant) → "YYYY-MM-DD", the calendar date in KUWAIT.
 *
 * TWO DECISIONS, BOTH ONE-LINE MISTAKES WITH THE SAME CONSEQUENCE:
 *
 * THE ZONE. A due date shown as the 17th to a customer whose phone is on London
 * time, while the server means the 18th in Kuwait, is a wrong answer to "how long
 * do I have" — and this is the one date in the app where that question has a
 * legal edge. `2026-09-17T21:30Z` is already the 18th in Kuwait.
 *
 * THE HANDOFF. It returns a calendar DATE, not a formatted string, because the
 * formatting belongs to the copy module: `copy.deleteScheduledBody` renders the
 * digits in the script of its own sentence. Formatting here in the app's language
 * would drop Eastern digits into an English AR_GAP sentence — the `staleBanner`
 * bug that i18n/digits.test.ts asserts against across the whole copy set.
 *
 * `en-CA` for ISO ordering, the same trick domain/booking.ts uses. The shape
 * matters: `formatEffectiveFrom` only formats a strict "YYYY-MM-DD" and returns
 * anything else untouched, so a different shape here would render the raw string
 * into the sentence rather than failing.
 */
export function erasureDueOn(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(iso));
}

// ------------------------------------------------------- what the section shows --

/**
 * The four things Account's exit slot can show, and they are not interchangeable.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FUNCTION AND NOT A CHAIN OF TERNARIES IN THE JSX.
 *
 * `offer` — the ordinary "Delete my account" row — is a STATEMENT that no
 * deletion is scheduled. Showing it while one is pending is the bug this whole
 * slice exists to fix: clock running, nothing on screen saying so, no route to
 * the cancel door. Showing `scheduled` when none is pending is the opposite lie.
 * So an unknown read resolves to `failed`, never to `offer`, and that rule is
 * worth more than the three lines it takes to express.
 *
 * Written as a pure function because the alternative is untestable here: this
 * workspace has no renderer (no jsdom, no @testing-library, react-test-renderer
 * gone in React 19) and adding one rewrites the trunk-owned pnpm-lock.yaml. The
 * same move as components/account/deletionOutcome.ts, for the same reason and
 * with the same result — the decision is asserted directly rather than inferred
 * from a screenshot.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export type DeletionSection =
  /** No answer yet. Draw nothing — this is the bottom of a scrolling screen. */
  | { kind: 'unknown' }
  /** The read failed, so neither statement can be made honestly. Offer a retry. */
  | { kind: 'failed' }
  /** A deletion is scheduled. Show when, and the way out. */
  | { kind: 'scheduled'; erasureDueAt: string | null; graceDays: number }
  /** Nothing scheduled. The ordinary row. */
  | { kind: 'offer' };

export function deletionSection(view: {
  loaded: boolean;
  loadFailed: boolean;
  state: { status: 'none' | 'pending'; erasureDueAt: string | null; graceDays: number } | null;
}): DeletionSection {
  if (!view.loaded) return { kind: 'unknown' };
  if (view.loadFailed) return { kind: 'failed' };
  // A missing state after a successful load is the same epistemic position as a
  // failed one: we do not know. It must not fall through to `offer`.
  if (!view.state) return { kind: 'failed' };
  if (view.state.status === 'pending') {
    return {
      kind: 'scheduled',
      erasureDueAt: view.state.erasureDueAt,
      graceDays: view.state.graceDays,
    };
  }
  return { kind: 'offer' };
}
