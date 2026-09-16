// @vitest-environment jsdom

/**
 * Merchant → Appointments → "Mark no-show", rendered and driven.
 *
 * =========================================================================
 * WHY THIS FILE RENDERS INSTEAD OF READING THE SOURCE
 * =========================================================================
 * `stateCensus.test.ts` already proves this screen HAS the four-state
 * vocabulary, and it would go on proving it with every guarantee below broken.
 * Every property here is about what a merchant reads and what a click actually
 * sends — DECISIONS.md #38's distinction, and on this control the gap between
 * the two is where the money is:
 *
 *   1. THE LINK IS A THREE-CONDITION COURTESY, NOT THE DESIGN'S ONE.
 *      `AVO Merchant Dashboard.dc.html:184` guards it on `canMark`, which the
 *      mock computes as `st === 'held'`. The real control also needs
 *      `perms.void` — a DIFFERENT permission from the one that opened the board
 *      — and a slot that has actually started. The seeded account this protects
 *      is ST-002 Hessa: `appointments: true`, `void: false`, `dashboard: false`,
 *      so under the board's own gate she could return a deposit and stamp a
 *      no-show against a named customer while unable to open the dashboard.
 *
 *   2. THE 403 IS STILL A STATE, BECAUSE #7 SAYS THE GATE IS NOT THE CONTROL.
 *      A link hidden from Hessa is a courtesy; the refusal is the control, and
 *      it is reachable — `perms` is a snapshot taken at sign-in, so a revocation
 *      in Accounts lands on an open board. Asserted with the server's OWN
 *      sentence, because paraphrasing it drops the half that says who can grant
 *      the permission back.
 *
 *   3. THE IDEMPOTENCY KEY IS PER BOOKING, HELD ACROSS RETRIES, AND CANNOT
 *      TRAVEL. #4. One key on two bookings is 422 `idempotency_key_reused`, and
 *      a retry that mints a fresh key loses the replay the header exists for.
 *      Lane B found the sibling defect on the scanner's void sheet. Neither
 *      half is visible in source text: only driving two clicks and reading what
 *      `mutate` was called with tells a held key from a re-minted one.
 *
 *   4. MONEY ANNOUNCES A DIFFERENT STRING THAN IT DRAWS. #1 and
 *      interaction-spec.md §2. The confirmation states an amount, and an amount
 *      read as "five thousand" instead of "five point zero zero zero Kuwaiti
 *      dinars" is the reason `<Money>` exists. The aria-label is asserted, not
 *      only the glyphs.
 *
 *   5. IT IS A BUTTON. The design draws `<a href="#2a">`, which is what a static
 *      mock writes for a control with nowhere to go. A POST behind an anchor is
 *      the wrong role, the wrong key, and a middle-click that opens a dead tab.
 *      Asserted as a NEGATIVE — no link in the cell — because a negative is
 *      exactly what gets rebuilt by accident.
 *
 * Cleanup is manual: no `globals: true` in this project, so
 * `@testing-library/react` registers no `afterEach(cleanup)` of its own.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import { ApiError } from '../api/client.js';
import type { MerchantBooking } from '../api/bookings.js';

/* ------------------------------------------------------------- the mocks -- */

/**
 * The board's three data hooks and the router's navigate, replaced.
 *
 * `Appointments` is mounted whole in the last describe — the key discipline
 * lives in the SCREEN, not in the row, because the key and the booking id share
 * one state object there on purpose. Mounting it means standing in for a
 * session, a salon read and a router that a jsdom realm has none of.
 *
 * `BookingRow` needs none of this; it takes everything as props, which is why
 * the first four describes below drive it directly.
 */
const useSalon = vi.fn();
const useSalonBookings = vi.fn();
const mutate = vi.fn();
const reset = vi.fn();
const markState = { isPending: false, error: null as unknown };
const perms = { void: true } as StaffPerms;

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({ useSalon: () => useSalon() }));
vi.mock('../api/bookings.js', () => ({
  useSalonBookings: () => useSalonBookings(),
  useMarkNoShow: () => ({ mutate, reset, ...markState }),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSession: () => ({ perms }) }));

const { Appointments, BookingRow, canMarkNoShow } = await import('./Appointments.js');

/** The real stylesheets, applied by jsdom's own cascade. `emphasisWeight`'s rig. */
function cssFrom(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}
const DASHBOARD_CSS = cssFrom('../app.css');

beforeAll(() => {
  for (const relative of [
    '../../../../packages/tokens/dist/avo-tokens.css',
    '../../../../packages/ui/src/ui.css',
    '../app.css',
  ]) {
    const style = document.createElement('style');
    style.textContent = cssFrom(relative);
    document.head.appendChild(style);
  }
});

/**
 * A FROZEN CLOCK, AND IT IS NOT A CONVENIENCE.
 *
 * `Appointments` computes the courtesy's third condition as
 * `canMarkNoShow(booking, perms, Date.now())`, so on a real clock this file's
 * fixtures pass or fail depending on what time of day the suite runs — which is
 * the shape of flake that reads as a broken control. `toFake: ['Date']` and
 * nothing else: faking timers wholesale would take React's scheduler with it.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  markState.isPending = false;
  markState.error = null;
  perms.void = true;
});

/* --------------------------------------------------------------- fixtures -- */

const STARTED = '2026-09-17T10:00:00.000Z';
/** One second after the slot began — the courtesy clock's true side. */
const NOW = Date.parse(STARTED) + 1000;

/**
 * A held deposit on a slot that has begun. The row the link is drawn on, with
 * every joined field the board renders — `memberName` above all, because the
 * response body of the mark does NOT carry it and the row must not lose it.
 */
const HELD: MerchantBooking = {
  id: 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40',
  memberId: 'MB-1a2b3c4d5e',
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: STARTED,
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  /** INTEGER FILS. 5.000 KD. No float reaches this field — #1. */
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T12:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

const SECOND: MerchantBooking = {
  ...HELD,
  id: 'BK-4e7b2a10-8c33-4f0d-b1a6-9d5c2e4f7a81',
  memberName: 'Hessa Al-Mutairi',
};

const noop = () => {};

function renderRow(booking: MerchantBooking, over: Partial<Parameters<typeof BookingRow>[0]> = {}) {
  return render(
    <table>
      <tbody>
        <BookingRow
          booking={booking}
          canMark={canMarkNoShow(booking, perms, NOW)}
          armed={false}
          marking={false}
          markError={null}
          onArm={noop}
          onCancel={noop}
          onConfirm={noop}
          {...over}
        />
      </tbody>
    </table>,
  );
}

const markLink = (name = 'Dana Al-Sabah') =>
  screen.queryByRole('button', { name: `Mark no-show for ${name}` });

/* ============================================ 1 · the three-condition gate = */

describe('the link needs three conditions, and the design only draws one', () => {
  it('is drawn on a held deposit, by a void holder, after the slot has started', () => {
    expect(canMarkNoShow(HELD, { void: true }, NOW)).toBe(true);
  });

  /**
   * ST-002 HESSA, THE SEEDED ACCOUNT THE GATE IS ABOUT. `appointments: true`
   * with `void: false` — every status and clock condition satisfied, and she
   * still must not be offered it.
   */
  it('is withheld from a holder of perms.appointments who lacks perms.void', () => {
    expect(canMarkNoShow(HELD, { void: false }, NOW)).toBe(false);
  });

  it.each([
    ['completed', 'not_markable'],
    ['cancelled', 'not_markable'],
    ['no_show_returned', 'already_no_show'],
  ] as const)('is withheld on a %s booking — the server answers %s', (status, answer) => {
    expect(
      canMarkNoShow({ ...HELD, status }, { void: true }, NOW),
      `a ${status} booking would earn ${answer}; the link must not be drawn on it`,
    ).toBe(false);
  });

  /**
   * THE CLOCK, AT THE SECOND. The server's gate is `now < startsAt` → 409
   * `appointment_not_started`, so the courtesy has to agree with it exactly:
   * the instant the slot begins is markable and the instant before it is not.
   * Asserted at the boundary rather than a comfortable distance from it,
   * because an off-by-one here draws a control that is certain to be refused.
   */
  it('is withheld one millisecond before the slot begins and offered at it', () => {
    const begins = Date.parse(STARTED);
    expect(canMarkNoShow(HELD, { void: true }, begins - 1)).toBe(false);
    expect(canMarkNoShow(HELD, { void: true }, begins)).toBe(true);
  });

  it('draws nothing in the cell when the conditions fail', () => {
    perms.void = false;
    renderRow(HELD);
    expect(markLink()).toBeNull();
  });
});

/* ================================================= 2 · what it is, visually = */

describe('the control is the design’s quiet link, and a button', () => {
  it('carries the design’s 12px, through the cascade and not through a class name', () => {
    renderRow(HELD);
    // `font: inherit` undresses the UA button; without it this is 13.333px in
    // the system font, which is a different typeface from the row around it.
    expect(getComputedStyle(markLink()!).fontSize).toBe('12px');
  });

  /**
   * `:184` names `rgba(28,27,25,0.45)`, which IS `--avo-text-muted-soft`.
   * Asserted against the DECLARATION rather than `getComputedStyle`, for
   * `emphasisWeight.test.tsx`'s measured reason: jsdom does not substitute
   * custom properties, so a computed read answers the same thing for the right
   * token and the wrong one. `cssTokenRefs.test.ts` proves the name resolves.
   */
  it('takes its colour from the token, not from a re-typed hex', () => {
    const rule = DASHBOARD_CSS.match(/\.appts__mark\s*\{([^}]*)\}/);
    expect(rule, 'no .appts__mark rule in app.css').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--avo-text-muted-soft\)/);
    expect(rule![1]).not.toMatch(/#|rgba\(/);
  });

  /**
   * A NEGATIVE, ASSERTED. The design's `<a href="#2a">` is a mock's placeholder;
   * this control POSTs and must not be an anchor. Nothing in the status cell is
   * a link.
   */
  it('is not an anchor — the cell contains no link at all', () => {
    const { container } = renderRow(HELD);
    expect(within(container).queryByRole('link')).toBeNull();
    expect(markLink()!.tagName).toBe('BUTTON');
  });

  /**
   * "Mark no-show" repeated down a column is a list of identical controls to
   * anyone not looking at the row. The visible text is unchanged — WCAG 2.5.3
   * holds because the accessible name still contains it.
   */
  it('names the customer in its accessible name and not in its visible text', () => {
    renderRow(HELD);
    const link = markLink()!;
    expect(link.textContent).toBe('Mark no-show');
    expect(link.getAttribute('aria-label')).toBe('Mark no-show for Dana Al-Sabah');
  });
});

/* ======================================================= 3 · the confirmation */

describe('the confirmation says which customer and how much', () => {
  it('replaces the link rather than sitting beside it', () => {
    renderRow(HELD, { armed: true });
    expect(markLink()).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, mark Dana Al-Sabah as a no-show' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  /**
   * #1 AT THE DISPLAY BOUNDARY, AND BOTH STRINGS.
   *
   * 5000 fils is "5.000 KD" to the eye and "5.000 Kuwaiti dinars" to a screen
   * reader — two different strings on two different nodes, which is exactly
   * what `<Money>` is for and exactly what `formatMoney` alone cannot do.
   */
  it('renders the deposit as integer fils, drawn and announced', () => {
    renderRow(HELD, { armed: true });
    const prompt = screen.getByText(/and mark a no-show\?$/);
    expect(prompt.textContent).toBe('Return 5.000 KD to Dana Al-Sabah and mark a no-show?');
    // Found BY the announced string — a different function on a different node.
    expect(within(prompt).getByLabelText('5.000 Kuwaiti dinars')).toBeTruthy();
  });

  /**
   * SCOPED TO THE PROMPT, and the ambiguity that forced it is itself the point:
   * the deposit CELL announces the same amount one column over, so an unscoped
   * query matches both. Two nodes saying "5.250 Kuwaiti dinars" about one
   * booking is correct — it is the same money, stated twice, in the two places
   * a merchant reads it.
   */
  it('does not lose the trailing zeroes that make it money', () => {
    renderRow({ ...HELD, depositFils: 5250 }, { armed: true });
    const prompt = screen.getByText(/and mark a no-show\?$/);
    expect(within(prompt).getByLabelText('5.250 Kuwaiti dinars')).toBeTruthy();
    expect(prompt.textContent).toContain('5.250 KD');
  });

  it('arms on the link, confirms on Yes, and abandons on Cancel', () => {
    const onArm = vi.fn();
    const { unmount } = renderRow(HELD, { onArm });
    fireEvent.click(markLink()!);
    expect(onArm).toHaveBeenCalledTimes(1);
    unmount();

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderRow(HELD, { armed: true, onConfirm, onCancel });
    fireEvent.click(screen.getByRole('button', { name: /^Yes, mark/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * THE IN-FLIGHT STATE. Both controls go dead, not just the destructive one:
   * a Cancel that lands while the POST is in flight cancels nothing and only
   * hides the answer.
   */
  it('goes dead while the mark is in flight', () => {
    renderRow(HELD, { armed: true, marking: true });
    const yes = screen.getByRole('button', { name: /^Yes, mark/ }) as HTMLButtonElement;
    const no = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(yes.textContent).toBe('Marking…');
    expect(yes.disabled).toBe(true);
    expect(no.disabled).toBe(true);
  });
});

/* ============================================ 4 · the refusals, in the row = */

describe('a refused mark is explained in its own row, and says what did not happen', () => {
  const refusal = (status: number, code: string, message: string) =>
    new ApiError(message, { status, code });

  /**
   * THE 403 — BUILT EVEN THOUGH THE LINK IS GATED. #7: the UI hiding a button
   * is a courtesy, not a control. The server's sentence is rendered verbatim
   * because it names the permission AND who can grant it.
   */
  it('renders the server’s own 403 sentence, not a paraphrase of it', () => {
    renderRow(HELD, {
      armed: true,
      markError: refusal(
        403,
        'forbidden',
        "You don't have permission to void a charge. A manager can grant it.",
      ),
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      "You don't have permission to void a charge. A manager can grant it.",
    );
    expect(alert.textContent).toContain('The deposit is still held.');
  });

  it.each([
    [409, 'appointment_not_started', 'That appointment has not started yet, so it cannot be marked as a no-show.'],
    [409, 'already_no_show', 'That appointment is already marked as a no-show and the deposit has been returned.'],
    [409, 'not_markable', 'That appointment was charged, so it cannot be marked as a no-show.'],
    [400, 'idempotency_key_required', 'Idempotency-Key is required.'],
  ])('renders the %s %s sentence verbatim', (status, code, message) => {
    renderRow(HELD, { armed: true, markError: refusal(status as number, code as string, message as string) });
    expect(screen.getByRole('alert').textContent).toContain(message as string);
  });

  /**
   * OFFLINE. `ApiError` with `status: 0` is the connection that never landed,
   * and the reassurance is the load-bearing half: a merchant who cannot tell a
   * lost request from a completed one marks it again.
   */
  it('tells a dead connection apart from a refusal, and still reassures', () => {
    renderRow(HELD, {
      armed: true,
      markError: new ApiError('No connection to the workspace.', {
        status: 0,
        code: 'network_error',
        offline: true,
      }),
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("We couldn't reach the workspace.");
    expect(alert.textContent).toContain('The deposit is still held.');
  });

  /** A 401 is the shell's job. A refusal flashed here names a permission she holds. */
  it('renders nothing for a 401 — the shell is already leaving', () => {
    renderRow(HELD, {
      armed: true,
      markError: new ApiError('Sign in to continue.', { status: 401, code: 'no_session' }),
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ================================================= 5 · the row, afterwards = */

describe('a marked row stops offering the link and says what happened', () => {
  it('shows the returned pill, drops the deadline, and withdraws the link', () => {
    renderRow({ ...HELD, status: 'no_show_returned' });
    expect(screen.getByText('No-show · returned')).toBeTruthy();
    // The auto-return deadline is about a deposit that is still held.
    expect(screen.queryByText(/if missed/)).toBeNull();
    expect(markLink()).toBeNull();
  });

  /**
   * THE DEPOSIT CELL DOES NOT CHANGE, and that is the point rather than an
   * omission: the amount returned IS the deposit, and a row that blanked it
   * would lose the only figure a disputed no-show is argued over.
   */
  it('keeps the deposit figure, announced as money', () => {
    renderRow({ ...HELD, status: 'no_show_returned' });
    expect(screen.getByLabelText('5.000 Kuwaiti dinars')).toBeTruthy();
  });
});

/* ====================================== 6 · the banner’s missing half-sentence */

describe('the banner names the control now that the control exists', () => {
  it('carries both halves of the design’s sentence, verbatim', () => {
    useSalon.mockReturnValue({ data: undefined, isPending: true, isError: false, isSuccess: false, isFetching: true, refetch: vi.fn() });
    useSalonBookings.mockReturnValue({ data: undefined, isPending: true, isError: false, isFetching: true, refetch: vi.fn() });
    const { container } = render(<Appointments />);
    const banner = container.querySelector('.avo-info__text') ?? container.querySelector('.avo-info');
    expect(banner!.textContent).toBe(
      'Deposits auto-return to the customer’s wallet 1 hour after a missed slot — the money ' +
        'never leaves the ecosystem. Use Mark no-show only for edge cases.',
    );
  });

  /**
   * THE EMPHASIS IS THE DESIGN'S 600 AND NOT THE BROWSER'S `bolder`.
   * `emphasisWeight.test.tsx` argues why a `<b>` with no author rule is not
   * "unstyled"; this pins the new one the second half introduced.
   */
  it('emphasises the control’s name at 600, like the hour beside it', () => {
    useSalon.mockReturnValue({ data: undefined, isPending: true, isError: false, isSuccess: false, isFetching: true, refetch: vi.fn() });
    useSalonBookings.mockReturnValue({ data: undefined, isPending: true, isError: false, isFetching: true, refetch: vi.fn() });
    const { container } = render(<Appointments />);
    const bolds = [...container.querySelectorAll('.avo-info b')];
    expect(bolds.map((b) => b.textContent)).toEqual(['1 hour', 'Mark no-show']);
    for (const b of bolds) expect(getComputedStyle(b).fontWeight).toBe('600');
  });
});

/* ============================================ 7 · the idempotency key, driven */

describe('one key names one booking, survives a retry, and never travels', () => {
  function board(items: MerchantBooking[]) {
    useSalon.mockReturnValue({
      data: { modules: { booking: true } },
      isPending: false,
      isError: false,
      isSuccess: true,
      isFetching: false,
      refetch: vi.fn(),
    });
    useSalonBookings.mockReturnValue({
      data: { items, nextCursor: null },
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    return render(<Appointments />);
  }

  const arm = (name: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Mark no-show for ${name}` }));
  const confirm = (name: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Yes, mark ${name} as a no-show` }));

  it('sends a key with the booking it was minted for', () => {
    board([HELD]);
    arm('Dana Al-Sabah');
    confirm('Dana Al-Sabah');
    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = mutate.mock.calls[0]![0] as { bookingId: string; idempotencyKey: string };
    expect(sent.bookingId).toBe(HELD.id);
    // A real v4 UUID, not a counter and not the booking id.
    expect(sent.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * THE RETRY KEEPS IT. A failure leaves the row armed with the SAME key, so a
   * second attempt is the replay the header exists for rather than a second
   * request the server must tell apart from the first.
   *
   * The failure is simulated the way it actually arrives — `mutate` reports an
   * error and does not call its `onSuccess`, so the armed object is untouched.
   */
  it('reuses the key when the merchant retries after a failure', () => {
    board([HELD]);
    arm('Dana Al-Sabah');
    confirm('Dana Al-Sabah');
    confirm('Dana Al-Sabah');
    expect(mutate).toHaveBeenCalledTimes(2);
    const first = (mutate.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
    const second = (mutate.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(second).toBe(first);
  });

  /**
   * AND IT CANNOT TRAVEL. `hashRequestBody({ salonId, bookingId })` means a key
   * that reaches a second booking is 422 `idempotency_key_reused` — the exact
   * refusal lane B earned on the scanner's void sheet. Arming another row
   * replaces the id AND the key together, because they are one object.
   */
  it('mints a different key for a different booking', () => {
    board([HELD, SECOND]);
    arm('Dana Al-Sabah');
    confirm('Dana Al-Sabah');
    // She changes her mind and arms the other row instead.
    arm('Hessa Al-Mutairi');
    confirm('Hessa Al-Mutairi');

    const [a, b] = mutate.mock.calls.map(
      (c) => c[0] as { bookingId: string; idempotencyKey: string },
    );
    expect(a!.bookingId).toBe(HELD.id);
    expect(b!.bookingId).toBe(SECOND.id);
    expect(b!.idempotencyKey).not.toBe(a!.idempotencyKey);
  });

  /** Only one row is armed at a time — a second confirmation cannot be open. */
  it('arms exactly one row', () => {
    board([HELD, SECOND]);
    arm('Dana Al-Sabah');
    expect(screen.queryAllByRole('button', { name: /^Yes, mark/ })).toHaveLength(1);
    expect(markLink('Hessa Al-Mutairi')).toBeTruthy();
    expect(markLink('Dana Al-Sabah')).toBeNull();
  });
});
