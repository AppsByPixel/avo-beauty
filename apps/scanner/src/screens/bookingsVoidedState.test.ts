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

const { BookingCard, STATUS_PILL, pillFor, dayTally, voidReasonLine } = await import(
  './BookingsScreen'
);
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

/**
 * The three reasons, as the route serves them. `voidReason` is emitted on every
 * row (api/src/routes/bookings.ts § voidReason) and is null on a void that
 * recorded no code — which is every void taken before migration 0050.
 */
const custWire = wire({ id: 'BK-CUST', status: 'cancelled', chargeVoided: true, voidReason: 'cust', startsAt: TWO_HOURS_AGO });
const wrongWire = wire({ id: 'BK-WRONG', status: 'cancelled', chargeVoided: true, voidReason: 'wrong', startsAt: TWO_HOURS_AGO });
const dupeWire = wire({ id: 'BK-DUPE', status: 'cancelled', chargeVoided: true, voidReason: 'dupe', startsAt: TWO_HOURS_AGO });

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

// == the reason ===============================================================

/**
 * WHAT A SCREEN OWES SOMEBODY WHO IS BEING TOLD SOMETHING ABOUT HER WORK AND
 * HAS NO ROUTE TO RESPOND.
 *
 * She cannot reply, cannot see who voided it, and cannot open the audit log —
 * ST-002 holds `permVoid: false`, `permCharges: false`, `permDashboard: false`.
 * The specs below are the four answers this card gives, and the fourth is a
 * refusal:
 *
 *   TELL HER.        The alternative is that a claim about her work exists, is
 *                    acted on in conversations she is not in, and is invisible
 *                    on the one screen she can open. "Payment voided" alone
 *                    leaves her to guess among three, and the worst of the three
 *                    is the one a person guesses.
 *   ATTRIBUTE IT.    "Reason given:" — the screen reports, it does not assert.
 *   DO NOT RANK IT.  One form for three codes. A screen that draws `cust` louder
 *                    tells her how to feel before she has read it, and — the
 *                    half that is easy to miss — makes the other two look
 *                    exonerating, which is a reassurance it has no standing to
 *                    give. A void for "wrong amount" is still her money and
 *                    still contestable.
 *   PROMISE NOTHING. No dispute control, no "ask a manager" chevron, nothing
 *                    that opens. There is no endpoint behind any of them, and an
 *                    affordance that leads nowhere is worse than none: it looks
 *                    like she has been heard.
 */
describe('the reason reaches the person it is about', () => {
  it('names which of the three, framed as something that was said rather than something true', () => {
    const cust = render(custWire);
    console.log('\n--- cust ---\n' + JSON.stringify(cust.text));
    const line = copy.bookingsVoidReason('Customer did not receive service');
    expect(cust.text).toContain(line);
    // The frame is the point, not decoration: the bare label alone would be the
    // screen making the claim.
    expect(cust.text).not.toContain('Customer did not receive service');
    expect(line.startsWith('Reason given')).toBe(true);
  });

  it('carries the other two in the same words the manager chose between', () => {
    expect(render(wrongWire).text).toContain(copy.bookingsVoidReason('Wrong amount or service'));
    expect(render(dupeWire).text).toContain(copy.bookingsVoidReason('Duplicate charge'));
  });

  /**
   * THE RAW CODE IS NEVER DRAWN. `voidReason` is `'cust'` on the wire and the
   * labels are this app's; a lookup miss falling through to the id would put
   * "cust" on a named artist's card. The enum in `ArtistBookingSchema` makes a
   * miss impossible, and this asserts the consequence rather than trusting it.
   */
  it('never renders the code itself', () => {
    for (const r of [render(custWire), render(wrongWire), render(dupeWire)]) {
      for (const t of r.text) {
        expect(['cust', 'wrong', 'dupe']).not.toContain(t.trim());
      }
    }
  });

  /**
   * NULL IS SILENCE, AND THE SCHEMA DECIDED IT.
   *
   * `voidReason: z.enum([...]).nullable().default(null)` cannot tell "this void
   * recorded no code" from "this API is too old to say" — both arrive as null.
   * So every sentence one could write here ("No reason recorded") would be a
   * claim about a record this screen has not read, and would be false against a
   * rolled-back server. It says nothing, which is exactly what the card said
   * before Lane A built the field, and is still the only honest thing to say.
   */
  it('says nothing at all when no code came back', () => {
    const r = render(voidedWire);
    expect(r.byTestID('booking-void-reason-BK-VOID')).toBeUndefined();
    expect(r.text.join(' ')).not.toContain('Reason given');
  });

  /**
   * SUBORDINATE TO THE PILL, not free-standing. `voidReason` non-null implies
   * `chargeVoided` and the database enforces it
   * (`transaction_void_reason_code_is_reversal_only`), so this row cannot arrive
   * — which is precisely why it is pinned. The same lesson as `status` versus
   * `chargeVoided` one section up: "cannot happen today" is how the last one
   * got through. A reason with no "Payment voided" above it is an accusation
   * with no subject, so the card draws neither rather than the dangling half.
   */
  it('draws nothing on a row that carries a reason but is not a reversal', () => {
    const impossible = render(wire({ id: 'BK-IMP', status: 'completed', chargeVoided: false, voidReason: 'cust' }));
    expect(impossible.byTestID('booking-void-reason-BK-IMP')).toBeUndefined();
    expect(impossible.text.join(' ')).not.toContain('Reason given');
  });

  /** `voidReasonLine` directly, since it is the one place the decision is made. */
  it('voidReasonLine returns null for every shape that must stay silent', () => {
    expect(voidReasonLine({ chargeVoided: true, voidReason: 'cust' })).toBe(
      copy.bookingsVoidReason('Customer did not receive service'),
    );
    expect(voidReasonLine({ chargeVoided: true, voidReason: null })).toBeNull();
    expect(voidReasonLine({ chargeVoided: false, voidReason: 'cust' })).toBeNull();
    expect(voidReasonLine({ chargeVoided: false, voidReason: null })).toBeNull();
  });
});

describe('it does not rank the three', () => {
  const styleOfLine = (id: string) => {
    const r = render(
      wire({ id: `BK-${id}`, status: 'cancelled', chargeVoided: true, voidReason: id as 'cust', startsAt: TWO_HOURS_AGO }),
    );
    return stylesOf(r.byTestID(`booking-void-reason-BK-${id}`)!);
  };

  /**
   * IDENTICAL STYLE OBJECTS, asserted by value. `cust` is the only one of the
   * three that is about her work rather than about the till, and the temptation
   * is to draw it louder. Drawing it louder is the screen taking a position on a
   * dispute it is not party to — and, worse in the other direction, it would
   * make "Duplicate charge" read as exonerating. Both are editorial. The words
   * carry the difference; they need no help.
   */
  it('draws all three in exactly the same form', () => {
    const [c, w, d] = [styleOfLine('cust'), styleOfLine('wrong'), styleOfLine('dupe')];
    console.log('cust style :', JSON.stringify(c));
    console.log('wrong style:', JSON.stringify(w));
    expect(c).toEqual(w);
    expect(c).toEqual(d);
  });

  /**
   * DECISIONS #115 IN THIS FILE'S READING — ALERT VERSUS DESCRIPTION — one level
   * quieter than the pill. The pill is 600 because a reversal is a description
   * rather than an alert; the reason is a clause OF that description, so it takes
   * muted body ink rather than weight. It is emphatically not `dangerText`: red
   * is the pill's job and saying it twice would turn reporting into alarm, which
   * is the one thing this line must not do on `cust`.
   */
  it('is muted body copy, not a second alarm and not a badge', () => {
    const s = Object.assign({}, ...styleOfLine('cust')) as Record<string, unknown>;
    console.log('reason line resolved style:', JSON.stringify(s));
    expect(s.color).toBe(color.textMutedStrong);
    expect(s.color).not.toBe(color.dangerText);
    expect(s.fontFamily).not.toBe('Inter_700Bold');
  });

  /**
   * AND IT IS LEGIBLE, WHICH THE FIRST VERSION OF THIS LINE WAS NOT.
   *
   * It was written as `styles.dim` — `textMutedSoft`, the phone line's ink —
   * on the reasoning that it should match the card's existing body treatment.
   * Measured: rgba(28,27,25,0.45) composites to #999898 and is **2.88:1** on
   * white. It fails AA, and the token file says so in its own words
   * (`generated.ts § mutedLabel`: "0.45 measures ~3.3:1 and fails"). The first
   * version of this spec asserted `toBe(color.textMutedSoft)`, which pinned the
   * mistake rather than catching it — a test that asserts which token was chosen
   * proves the choice was made, not that it was right.
   *
   * So the assertion is the RATIO. `textMutedStrong` is 0.7 → #605F5E → 6.37:1,
   * and it is already this card's own muted ink (the source pill, `settledInk`),
   * so nothing new was invented to fix it.
   *
   * The card is `color.white` and stays white here — a reversal does not recede
   * (see "the weight" above) — so white is the ground this must clear on.
   */
  it('clears AA on the white the reversed card keeps', () => {
    const composite = (rgba: string, bg: [number, number, number]) => {
      const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba)!;
      const a = Number(m[4]);
      const mix = [1, 2, 3].map((i) => Math.round(Number(m[i]) * a + Number(bg[i - 1]) * (1 - a)));
      return '#' + mix.map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    const onWhite = composite(color.textMutedStrong, [255, 255, 255]);
    const ratio = contrastRatio(onWhite, color.white);
    console.log(`reason line: ${color.textMutedStrong} -> ${onWhite} on white = ${ratio.toFixed(2)}:1`);
    // The control, and the reason this spec exists: the ink first chosen here.
    const softOnWhite = composite(color.textMutedSoft, [255, 255, 255]);
    const softRatio = contrastRatio(softOnWhite, color.white);
    console.log(`rejected   : ${color.textMutedSoft} -> ${softOnWhite} on white = ${softRatio.toFixed(2)}:1`);
    expect(softRatio).toBeLessThan(AA_NORMAL_TEXT);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * NO AFFORDANCE, asserted rather than assumed. There is no endpoint by which
   * an artist can contest a void; a Pressable here would be a control that looks
   * like it was heard and was not. Escalated in the report as a product gap, not
   * papered over with a button.
   */
  it('offers her nothing to press, because there is nothing behind it', () => {
    const node = render(custWire).nodes.find((n) => n.props.testID === 'booking-void-reason-BK-CUST')!;
    expect(node.props.onPress).toBeUndefined();
    expect(node.props.accessibilityRole).toBeUndefined();
  });
});
