/**
 * Aftab's item 8 — "Show booking as marked done if the payment is done" — on the
 * artist's own day.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG, MEASURED RATHER THAN DESCRIBED
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /charges` sets a settled booking to `completed` inside the money
 * transaction (api/src/services/charge.ts:781-789 — the ONLY place in the API
 * that writes that status). `GET /artists/me/bookings` returns rows from
 * `Date.now() - 24h` onward and `serialiseBooking` puts `status` on the wire, so
 * the scanner has held the answer all along. `BookingCard` drew time, duration,
 * deposit, service, name, tier and source — and no status. An appointment she
 * rang up at 11:00 was byte-identical at 15:00 to one she had not touched.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE STATES ARRIVE NOW; FOUR ARE DEFINED. THIS FILE PINS THE TWO IT NAMED.
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT STOPPED BEING TRUE. It read that
 * the route filters the day to `inArray(booking.status, ['deposit_held',
 * 'completed'])` and that `cancelled` therefore CANNOT reach this card — quoted
 * from the source, correct when written, and the report it points at asked for
 * exactly the widening that then happened. Lane A widened it: `cancelled` is now
 * admitted when the settling transaction carries `reverses_transaction_id`. So
 * this file's own request is what made its own comment false, which is the only
 * kind of stale comment that is nobody's oversight.
 *
 * `no_show_returned` still cannot arrive. `cancelled` can, and when it does it
 * is ALWAYS a reversal — which is `bookingsVoidedState.test.ts`'s subject, not
 * this file's. The specs here are unchanged in meaning: the map is exhaustive
 * because an unhandled status renders not as nothing but as an ordinary live
 * appointment, and this file's exhaustiveness spec fails the day
 * `BookingSchema.status` grows a fifth member.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HARNESS IS `bookingsErasedCard.test.ts`'s, AND ITS LIMITS ARE THE SAME
 * ═════════════════════════════════════════════════════════════════════════════
 * No jsdom, no testing-library, no `react-test-renderer` under React 19. The
 * card is a function returning plain objects, so it is called and its tree is
 * walked. Every fixture is a wire body typed out here, so nothing on the server
 * can reach an assertion in this file — what is proved is the CARD's behaviour
 * given a payload, never the payload.
 */

import { describe, expect, it, vi } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from '@avo/tokens';

// ------------------------------------------------------------ the two mocks --

vi.mock('react-native', () => {
  const passthrough = (name: string) => name;
  return {
    View: passthrough('View'),
    Text: passthrough('Text'),
    Pressable: passthrough('Pressable'),
    ScrollView: passthrough('ScrollView'),
    Image: passthrough('Image'),
    AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    Linking: { openURL: () => Promise.resolve(true) },
    StyleSheet: {
      create: (sheet: unknown) => sheet,
      flatten: (s: unknown) => s,
      hairlineWidth: 1,
      absoluteFillObject: {},
    },
    Animated: { View: passthrough('Animated.View'), timing: () => ({ start() {} }), Value: class {} },
    Easing: { out: (f: unknown) => f, ease: (n: number) => n },
    ActivityIndicator: passthrough('ActivityIndicator'),
    TextInput: passthrough('TextInput'),
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Svg: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
  Rect: 'Rect',
  G: 'G',
  Defs: 'Defs',
  LinearGradient: 'LinearGradient',
  Stop: 'Stop',
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), useCallback: (fn: unknown) => fn };
});

const { BookingCard, STATUS_PILL, dayTally } = await import('./BookingsScreen');
const { ArtistBookingSchema } = await import('../api/artist');
const { copy } = await import('../copy/en');
const { color } = await import('../theme');

// ------------------------------------------------------------- the fixtures --

/**
 * NOTE: `wire()` below deliberately OMITS `chargeVoided`, and that is a live
 * assertion rather than an oversight. `ArtistBookingSchema` declares it
 * `.default(false)` precisely so an older payload parses, and every fixture in
 * this file exercising that default is the cheapest proof the default holds.
 * The field's own specs are in `artistBookingWire.test.ts` and
 * `bookingsVoidedState.test.ts`.
 *
 * `startsAt` is two hours in the PAST on purpose. That is the whole case: the
 * 24-hour window keeps this morning's appointment on her screen all afternoon,
 * and it is also what makes `isRecent` say "NEW" about finished work — see the
 * collision spec.
 */
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const IN_THREE_HOURS = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
/** Beyond `isRecent`'s twelve hours, so it is upcoming without also being NEW. */
const IN_TWO_DAYS = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

function wire(over: Record<string, unknown>) {
  return {
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-1',
    branchId: 'BR-1',
    serviceId: 'SV-1',
    startsAt: IN_THREE_HOURS,
    endsAt: IN_THREE_HOURS,
    durationMin: 60,
    depositFils: 5000,
    status: 'deposit_held',
    source: 'app',
    changeableUntil: TWO_HOURS_AGO,
    noShowReturnDueAt: IN_THREE_HOURS,
    rescheduledCount: 0,
    calendarSyncState: 'synced',
    memberName: 'Dana Al-Fahad',
    memberPhone: '+965 9912 4408',
    memberErased: false,
    memberTier: 'gold',
    serviceName: 'Balayage',
    ...over,
  };
}

const heldWire = wire({ id: 'BK-HELD' });
/** Charged at 11:00, still on her screen at 15:00. The slice, in one fixture. */
const paidWire = wire({ id: 'BK-PAID', status: 'completed', startsAt: TWO_HOURS_AGO });

// -------------------------------------------------------------- the walker --

interface Node {
  type: unknown;
  props: Record<string, unknown>;
}

function flatten(node: unknown, out: Node[] = []): Node[] {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!('props' in el) || el.props === undefined) return out;
  out.push({ type: el.type, props: el.props });
  flatten(el.props.children, out);
  return out;
}

function texts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { props?: Record<string, unknown> };
  if (el.props) texts(el.props.children, out);
  return out;
}

/** Every style object on a node, flattened out of the `[a, b && c]` arrays. */
function stylesOf(node: Node): Record<string, unknown>[] {
  const s = node.props.style;
  const list = Array.isArray(s) ? s : [s];
  return list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}

function render(raw: unknown) {
  const booking = ArtistBookingSchema.parse(raw);
  const tree = BookingCard({ booking });
  const nodes = flatten(tree);
  return {
    booking,
    nodes,
    testIDs: nodes.map((n) => n.props.testID).filter((t): t is string => typeof t === 'string'),
    text: texts(tree),
    byTestID: (id: string) => nodes.find((n) => n.props.testID === id),
  };
}

// ══════════════════════════════════════════════════ the state that was missing ══

describe('a charged booking says so', () => {
  it('draws the paid pill, and the held one it is otherwise identical to does not', () => {
    const paid = render(paidWire);
    const held = render(heldWire);
    console.log('\n--- paid  ---\n' + JSON.stringify(paid.text));
    console.log('--- held  ---\n' + JSON.stringify(held.text));

    expect(paid.text).toContain(copy.bookingsStatusPaid);
    expect(paid.testIDs).toContain('booking-status-BK-PAID');

    expect(held.text).not.toContain(copy.bookingsStatusPaid);
    expect(held.testIDs).not.toContain('booking-status-BK-HELD');
  });

  /**
   * DE-EMPHASIS, and why it is a separate assertion from the pill.
   *
   * An artist scanning her day wants the NEXT one to stand out. A finished row
   * drawn at the same weight competes with it, and a 10px pill is not a
   * scan-distance signal. The settled card drops off the white lift onto
   * `surfaceAlt`, which sits BELOW the page's `surface` rather than above it.
   */
  it('recedes — the settled card leaves the white lift and its ink mutes', () => {
    const paid = render(paidWire);
    const held = render(heldWire);

    const bg = (r: ReturnType<typeof render>, id: string) =>
      stylesOf(r.byTestID(id)!).map((s) => s.backgroundColor).filter(Boolean);

    expect(bg(held, 'booking-BK-HELD')).toEqual([color.white]);
    expect(bg(paid, 'booking-BK-PAID')).toEqual([color.white, color.surfaceAlt]);

    // The service line — `color.ink` on a live row, muted on a settled one.
    const inks = (r: ReturnType<typeof render>) =>
      r.nodes.flatMap(stylesOf).map((s) => s.color).filter(Boolean);
    expect(inks(paid)).toContain(color.textMutedStrong);
  });

  /**
   * THE COLLISION THIS SLICE FORCED. `isRecent` is `startsAt - now < 12h` with no
   * lower bound, so EVERY past booking in the 24-hour window reads NEW — this
   * morning's charged appointment included. A card wearing both NEW and Paid is
   * nonsense, so "new" now requires the deposit to still be held: the server's
   * status, never a clock. (The remaining half — a still-held booking from
   * yesterday evening reading NEW — is reported, not fixed here.)
   */
  it('is not also NEW, though the twelve-hour rule on its own would say it is', () => {
    const paid = render(paidWire);
    expect(paid.text).not.toContain(copy.bookingsNew);
    // The control: the same timestamp, still held, DOES read new.
    const stillHeld = render(wire({ id: 'BK-STALE', startsAt: TWO_HOURS_AGO }));
    expect(stillHeld.text).toContain(copy.bookingsNew);
  });

  /**
   * She may still need to ring a client after the appointment — a forgotten bag,
   * a follow-up. Being paid is not being erased, and nothing about the contact
   * row changes.
   */
  it('keeps Call and WhatsApp, because paid is not erased', () => {
    const paid = render(paidWire);
    expect(paid.testIDs).toContain('booking-call-BK-PAID');
    expect(paid.testIDs).toContain('booking-wa-BK-PAID');
  });
});

// ═══════════════════════════════════════════════════ four defined, two drawn ══

describe('the status map', () => {
  it('covers every status the contract can produce', () => {
    const options = ArtistBookingSchema.shape.status.options;
    expect(Object.keys(STATUS_PILL).sort()).toEqual([...options].sort());
  });

  /**
   * `deposit_held` draws NOTHING, deliberately. The merchant's board needs a
   * "Deposit held" pill because it is a table with a status column; this card
   * already says "Deposit 5.000" in that exact position. A second pill repeating
   * it would land on the majority of rows for no information.
   */
  it('leaves the ordinary row alone', () => {
    expect(STATUS_PILL.deposit_held).toBeNull();
  });

  /**
   * "Paid" DIVERGES from the merchant's "Completed", with a reason; the other
   * two AGREE with it, because there is none. The artist's question at the
   * counter is "have I rung this up?", and `completed` is written in exactly one
   * place in the API — inside the charge transaction, when a held deposit is
   * consumed — so "Paid" is the most literal reading of what the server asserts.
   * The merchant's board reports outcomes across staff and needs the neutral
   * word; she sees two of the four.
   */
  it('says Paid where the merchant says Completed, and agrees everywhere else', () => {
    expect(STATUS_PILL.completed?.label).toBe('Paid');
    expect(STATUS_PILL.no_show_returned?.label).toBe('No-show · returned');
    expect(STATUS_PILL.cancelled?.label).toBe('Cancelled');
  });

  /**
   * Non-negotiable #9's neighbourhood: every pair these pills introduce, computed
   * over the two card grounds they can sit on. `textMutedSoft` is NOT asserted
   * here — it is already 2.88:1 on white before this change and is reported
   * rather than silently carried into a new assertion.
   */
  it.each(['completed', 'no_show_returned', 'cancelled'] as const)(
    '%s clears AA on both the live and the settled card',
    (status) => {
      const pill = STATUS_PILL[status]!;
      const ratio = contrastRatio(flatten2(pill.text, pill.bg), pill.bg);
      console.log(`${status}: "${pill.label}" ${pill.text} on ${pill.bg} = ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

      // And the muted ink the settled card uses for its time and service lines,
      // over the ground that card actually has.
      const ink = contrastRatio(flatten2(color.textMutedStrong, color.surfaceAlt), color.surfaceAlt);
      console.log(`settled ink: textMutedStrong on surfaceAlt = ${ink.toFixed(2)}:1`);
      expect(ink).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );
});

/** Composite an `rgba(...)` foreground onto an opaque hex; pass a hex through. */
function flatten2(fg: string, bgHex: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(fg);
  if (!m) return fg;
  const [fr, fg2, fb, fa] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const bg = bgHex.replace('#', '');
  const [br, bgn, bb] = [
    parseInt(bg.slice(0, 2), 16),
    parseInt(bg.slice(2, 4), 16),
    parseInt(bg.slice(4, 6), 16),
  ];
  const mix = (f: number, b: number) => Math.round(f * fa + b * (1 - fa));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(fr, br))}${hex(mix(fg2, bgn))}${hex(mix(fb, bb))}`;
}

// ═══════════════════════════════════════════ the header that called them all up ══

describe('the count line', () => {
  /**
   * "5 upcoming" over a list where two are finished is the same lie the card was
   * telling, one line higher. Fixing the card and leaving the header would have
   * shipped a screen that contradicts itself.
   */
  it('stops counting finished work as upcoming', () => {
    const tally = dayTally([
      ArtistBookingSchema.parse(wire({ id: 'BK-LATER', startsAt: IN_TWO_DAYS })),
      ArtistBookingSchema.parse(paidWire),
      ArtistBookingSchema.parse(wire({ id: 'BK-P2', status: 'completed', startsAt: TWO_HOURS_AGO })),
    ]);
    // Three cards on the screen, and only one of them is still ahead of her.
    expect(tally).toEqual({ upcoming: 1, isNew: 0, paid: 2, voided: 0 });
    expect(copy.bookingsCount(tally.upcoming, tally.isNew, tally.paid, tally.voided)).toBe(
      '1 upcoming · 2 paid',
    );
  });

  it('is the design line, verbatim, when nothing is finished', () => {
    const tally = dayTally([ArtistBookingSchema.parse(heldWire)]);
    expect(copy.bookingsCount(tally.upcoming, tally.isNew, tally.paid, tally.voided)).toBe(
      '1 upcoming · 1 new',
    );
    // And the later segments never appear on a day with nothing charged.
    expect(copy.bookingsCount(3, 0, 0, 0)).toBe('3 upcoming');
  });
});
