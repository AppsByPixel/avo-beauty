/**
 * A VOIDED CHARGE ON THE ARTIST'S OWN DAY - the client half of Lane A's fix.
 *
 * =============================================================================
 * WHAT THE SERVER FIXED, AND WHAT IT LEFT ON THIS SIDE
 * =============================================================================
 * A void sets the booking to `cancelled` (api/src/routes/charges.ts), and the
 * day query used to admit only `deposit_held` and `completed` - so an
 * appointment the artist had just been paid for VANISHED from her screen the
 * moment a manager reversed the charge. Lane A now admits `cancelled` when, and
 * only when, the settling transaction carries `reverses_transaction_id`, and
 * sends `chargeVoided` alongside it.
 *
 * Its handoff says the fix is incomplete without this side, and it is right
 * twice over:
 *
 *   1. `ArtistBookingSchema` was STRIPPING `chargeVoided` - proved, separately
 *      and at the parse rather than the render, in `artistBookingWire.test.ts`.
 *   2. `STATUS_PILL`'s `cancelled` arm was dead by construction and is now live,
 *      so the row came back wearing a neutral grey "Cancelled" at the same
 *      visual weight as "Paid". She watched that card say Paid ninety seconds
 *      earlier; "Cancelled" tells her the customer called off work she performed.
 *
 * =============================================================================
 * THE THREE CLAIMS THIS FILE PINS
 * =============================================================================
 *   THE WORD    branches on `chargeVoided`, never on `status`. The two are
 *               equivalent TODAY only because of a route predicate Lane A has
 *               said it may widen; the specs below drive both halves apart with
 *               fixtures the route cannot currently produce, which is the only
 *               way to prove the branch is reading the field.
 *   THE WEIGHT  is elevation and colour, not font weight. The reversed row keeps
 *               the white lift and full ink that `completed` gives up, and the
 *               pill stays 600 - `emphasisWeight.test.ts`'s frozen 700 set still
 *               has exactly one member, `NEW`.
 *   THE HEADER  counts it, because a reversal silently leaves `paid` otherwise.
 *
 * The harness is `bookingsDoneState.test.ts`'s and its limits are the same: no
 * jsdom, no testing-library, no react-test-renderer under React 19. The card is
 * a function returning plain objects, so it is called and its tree walked. Every
 * fixture is a wire body typed out here, so nothing on the server can reach an
 * assertion in this file.
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

const { BookingCard, STATUS_PILL, pillFor, dayTally } = await import('./BookingsScreen');
const { ArtistBookingSchema } = await import('../api/artist');
const { copy } = await import('../copy/en');
const { color } = await import('../theme');

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


const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const IN_THREE_HOURS = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

function wire(over: Record<string, unknown>) {
  return {
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-003',
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
    chargeVoided: false,
    ...over,
  };
}

/**
 * The case, exactly as the route can serve it: she was charged at 11:00, a
 * manager voided at 11:02, and it is now the afternoon. `status` is `cancelled`
 * because the void wrote that; `chargeVoided` is what says the customer did not
 * call off.
 */
const voidedWire = wire({
  id: 'BK-VOID',
  status: 'cancelled',
  chargeVoided: true,
  startsAt: TWO_HOURS_AGO,
});

/** The control it must not look like: the same morning, charge still standing. */
const paidWire = wire({ id: 'BK-PAID', status: 'completed', startsAt: TWO_HOURS_AGO });

const heldWire = wire({ id: 'BK-HELD' });

// == the word =================================================================

describe('a reversed appointment does not say the customer cancelled', () => {
  it('draws "Payment voided" where the status alone would have drawn "Cancelled"', () => {
    const voided = render(voidedWire);
    console.log('\n--- voided ---\n' + JSON.stringify(voided.text));

    expect(voided.text).toContain(copy.bookingsStatusVoided);
    expect(voided.text).not.toContain(copy.bookingsStatusCancelled);
    expect(voided.testIDs).toContain('booking-status-BK-VOID');
  });

  /**
   * THE WORD ITSELF, asserted rather than left to the pill. "Voided" is the
   * app's own verb (`voidSheetTitle`, `voidConfirm`, `voidedAtNote`); "Payment"
   * is the load-bearing noun, because bare "Voided" beside a time reads as the
   * APPOINTMENT being voided - the same misreading "Cancelled" produces.
   *
   * "Refunded" is excluded explicitly: non-negotiable #5 makes every refund
   * wallet credit, and the word would suggest a remedy granted rather than a
   * charge undone.
   */
  it('says payment, not appointment, and does not say refunded', () => {
    expect(copy.bookingsStatusVoided).toBe('Payment voided');
    expect(copy.bookingsStatusVoided.toLowerCase()).toContain('payment');
    expect(copy.bookingsStatusVoided.toLowerCase()).not.toContain('refund');
    expect(copy.bookingsStatusVoided.toLowerCase()).not.toContain('cancel');
  });

  /**
   * NON-NEGOTIABLE #2, EXECUTABLE. The route admits `cancelled` only when the
   * reversal id is non-null, so `status === 'cancelled'` and `chargeVoided` are
   * equivalent on today's wire - and a client branching on the status would pass
   * every other spec in this file.
   *
   * These two fixtures are ones the route cannot currently produce. They are the
   * only way to show the branch is reading the SERVER'S field rather than
   * re-deriving it, and they are exactly what breaks on the day Lane A widens
   * the predicate to let a customer's cancellation through.
   */
  it('reads the field, not the status - a cancelled row that is NOT a reversal keeps "Cancelled"', () => {
    const customerCancelled = render(wire({ id: 'BK-CX', status: 'cancelled', chargeVoided: false }));
    expect(customerCancelled.text).toContain(copy.bookingsStatusCancelled);
    expect(customerCancelled.text).not.toContain(copy.bookingsStatusVoided);
  });

  it('reads the field, not the status - a completed row that IS a reversal says so', () => {
    const odd = render(wire({ id: 'BK-ODD', status: 'completed', chargeVoided: true }));
    expect(odd.text).toContain(copy.bookingsStatusVoided);
    expect(odd.text).not.toContain(copy.bookingsStatusPaid);
  });

  /** `pillFor` directly, since it is the one place the decision is made. */
  it('pillFor checks the reversal before the status map, for every status', () => {
    for (const status of ArtistBookingSchema.shape.status.options) {
      expect(pillFor({ status, chargeVoided: true })?.label).toBe(copy.bookingsStatusVoided);
    }
    expect(pillFor({ status: 'cancelled', chargeVoided: false })?.label).toBe(
      copy.bookingsStatusCancelled,
    );
    expect(pillFor({ status: 'deposit_held', chargeVoided: false })).toBeNull();
  });

  /**
   * The `cancelled` ARM STAYS, and stays worded for the other case. Lane A chose
   * deliberately to keep a customer's cancellation off her day and pinned the
   * exclusion with a spec, so this entry is currently unreachable through the
   * route - but it is the right word the day that changes, and deleting it would
   * make the exhaustiveness ratchet in `bookingsDoneState.test.ts` unfixable.
   */
  it('leaves STATUS_PILL.cancelled saying "Cancelled", for the cancellation that is one', () => {
    expect(STATUS_PILL.cancelled?.label).toBe(copy.bookingsStatusCancelled);
  });
});

// == the weight ===============================================================

describe('a reversed row is neither done nor upcoming', () => {
  /**
   * THE RECESSION SPLIT. `completed` deliberately drops off the white lift onto
   * `surfaceAlt` and mutes its ink so it stops competing with the next
   * appointment. A reversal is settled and NOT finished - her completed work in
   * an unresolved state, with no affordance anywhere she can reach - so it keeps
   * both.
   */
  it('keeps the white lift that a finished row gives up', () => {
    const bg = (r: ReturnType<typeof render>, id: string) =>
      stylesOf(r.byTestID(id)!)
        .map((s) => s.backgroundColor)
        .filter(Boolean);

    console.log('paid card bg  :', JSON.stringify(bg(render(paidWire), 'booking-BK-PAID')));
    console.log('voided card bg:', JSON.stringify(bg(render(voidedWire), 'booking-BK-VOID')));

    // The control: a paid row recedes onto surfaceAlt, below the page surface.
    expect(bg(render(paidWire), 'booking-BK-PAID')).toEqual([color.white, color.surfaceAlt]);
    // The reversal does not.
    expect(bg(render(voidedWire), 'booking-BK-VOID')).toEqual([color.white]);
    // And neither does a live one, which is the shape it now shares.
    expect(bg(render(heldWire), 'booking-BK-HELD')).toEqual([color.white]);
  });

  it('keeps full ink on the time and the service', () => {
    const inks = (r: ReturnType<typeof render>) =>
      r.nodes.flatMap(stylesOf).map((s) => s.color).filter(Boolean);
    // The control: the paid card mutes.
    expect(inks(render(paidWire))).toContain(color.textMutedStrong);
    // `textMutedStrong` still appears on the voided card - it is the PILL's ink
    // on a no-show and the source pill's ink everywhere - so the assertion is on
    // the two nodes that actually carry `settledInk`, not on the colour's
    // absence from the whole tree.
    const voided = render(voidedWire);
    const timeAndService = voided.nodes.filter((n) => {
      const st = stylesOf(n);
      return st.some((x) => x.fontSize === 17 || x.fontSize === 14.5);
    });
    expect(timeAndService.length).toBeGreaterThanOrEqual(2);
    for (const node of timeAndService) {
      expect(stylesOf(node).map((s) => s.color)).not.toContain(color.textMutedStrong);
    }
  });

  /**
   * IT IS STILL NOT `NEW`. `settled` is what suppresses the NEW pill and it is
   * deliberately unchanged - a reversed booking is two hours in the past and
   * `isRecent` has no lower bound, so without this it would wear NEW and
   * "Payment voided" at once.
   */
  it('is not also NEW, though it is inside the twelve-hour window', () => {
    expect(render(voidedWire).text).not.toContain(copy.bookingsNew);
  });

  /**
   * DECISIONS #115 - ALERT versus DESCRIPTION, and this is a description. `NEW`
   * means "this arrived, act"; a void is finished, is somebody else's action,
   * and offers her no affordance at all - she holds neither `perms.void` nor
   * `perms.charges`. Drawing it at 700 would promise a response she cannot make.
   * The frozen 700 set in `emphasisWeight.test.ts` still has one member.
   */
  it('draws the pill at 600, the weight every other pill in this card uses', () => {
    const pill = render(voidedWire).byTestID('booking-status-BK-VOID')!;
    const inner = flatten(pill.props.children);
    const fonts = inner.flatMap(stylesOf).map((s) => s.fontFamily).filter(Boolean);
    console.log('voided pill face:', JSON.stringify(fonts));
    expect(fonts).toContain('Inter_600SemiBold');
    expect(fonts).not.toContain('Inter_700Bold');
  });

  /**
   * NON-NEGOTIABLE #9's neighbourhood. `dangerBg`/`dangerText` is not a new pair
   * - it is the one this card already gives `no-show · returned`, and both mean
   * the customer's money went back. Computed over the ground the reversed card
   * actually has, which is `white`, since it no longer recedes.
   */
  it('clears AA on the ground it actually sits on', () => {
    const ratio = contrastRatio(color.dangerText, color.dangerBg);
    console.log(`voided pill: ${color.dangerText} on ${color.dangerBg} = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(color.dangerBg).toBe(STATUS_PILL.no_show_returned?.bg);
  });
});

// == the header ===============================================================

describe('the count line accounts for it', () => {
  /**
   * WITHOUT THIS SEGMENT THE HEADER SILENTLY DECREMENTS. A reversed booking is
   * `cancelled`, so it counts in none of `upcoming`, `isNew` or `paid`: the
   * moment a manager voids this morning's charge, "2 paid" becomes "1 paid" and
   * a card she has never seen appears underneath with nothing connecting them.
   */
  it('names the reversal instead of just dropping it out of paid', () => {
    const tally = dayTally([
      ArtistBookingSchema.parse(heldWire),
      ArtistBookingSchema.parse(paidWire),
      ArtistBookingSchema.parse(voidedWire),
    ]);
    // `heldWire` starts in three hours, so it is genuinely NEW as well as
    // upcoming - which makes this the all-four-segments case.
    expect(tally).toEqual({ upcoming: 1, isNew: 1, paid: 1, voided: 1 });
    const line = copy.bookingsCount(tally.upcoming, tally.isNew, tally.paid, tally.voided);
    console.log('count line:', line);
    expect(line).toBe('1 upcoming · 1 new · 1 paid · 1 voided');
  });

  /** It drops at zero, so an ordinary day renders the design's sentence unchanged. */
  it('disappears on a day with nothing reversed', () => {
    expect(copy.bookingsCount(3, 0, 0, 0)).toBe('3 upcoming');
    expect(copy.bookingsCount(1, 1, 0, 0)).toBe('1 upcoming · 1 new');
  });

  /**
   * COUNTED OFF THE FIELD, not off the status - the same #2 point as the pill,
   * one line higher. A customer's cancellation must not be counted as a
   * reversal on the day the route starts sending them.
   */
  it('does not count a cancellation that is not a reversal', () => {
    const tally = dayTally([
      ArtistBookingSchema.parse(wire({ id: 'BK-CX', status: 'cancelled', chargeVoided: false })),
    ]);
    expect(tally.voided).toBe(0);
  });
});
