/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE SOURCES, TWO OF THEM RENDERING AS ONE — AND A CLIENT WITH NO ACCOUNT
 * ═════════════════════════════════════════════════════════════════════════════
 * The dashboard gained manually-created appointments, and `BookingSchema` grew
 * with them: `source` is a THREE-value enum now, `memberId` is nullable, a
 * booking may carry a `guestName` instead, and a `merchant` booking is always
 * zero-deposit — nothing held, nothing returned.
 *
 * Three things on this card were written when none of that was true:
 *
 *   1. The source pill was `source === 'google_calendar' ? gcal : app` — a
 *      two-armed ternary over what is now three values. A front-desk booking
 *      rendered as "AVO app", which tells the artist the customer booked it
 *      herself. She is the reader that distinction is FOR.
 *
 *   2. `no_show_returned` rendered "No-show · returned" unconditionally. On a
 *      zero-deposit row nothing came back, and she has no other screen to check
 *      that against (`permDashboard: false`, api/src/db/seed.ts § ST-002).
 *
 *   3. `memberName` and `memberTier` were read straight off the row. On a guest
 *      booking the first is null and the second is too — and `tierStyles[null]`
 *      is `undefined`, so `tier.pillBg` one line later threw and took the whole
 *      DAY down rather than one card.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MAP IS THE FIX; THE LABEL IS THE SYMPTOM
 * ─────────────────────────────────────────────────────────────────────────────
 * The spec that matters most below is not "merchant says Front desk" — it is
 * that `SOURCE_PILL`'s key set is exactly the contract's enum, derived from
 * `ArtistBookingSchema` rather than typed out. A ternary with a default arm
 * reproduces this defect on the next value the contract adds, silently, and a
 * hand-written list of three does the same thing one release later. The type is
 * the ratchet; this asserts it at runtime as well, because a `Record` whose key
 * type someone widens back to `string` still compiles.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HARNESS IS `bookingsErasedCard.test.ts`'s, AND SO IS ITS ARGUMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * No jsdom in this package, no testing-library, no react-test-renderer in React
 * 19. `BookingCard` is a function returning a plain element tree, so it is
 * called and the tree is walked. See that file's header for why the two mocks
 * below are all that is needed and what they do not stand in for.
 *
 * Merchant surfaces are English-only (design/README.md, Known gap 1), so there
 * is one language here and that is not an omission.
 */

import { describe, expect, it, vi } from 'vitest';

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

const { BookingCard, SOURCE_PILL, pillFor, clientName } = await import('./BookingsScreen');
const { ArtistBookingSchema } = await import('../api/artist');
const { copy } = await import('../copy/en');

// ------------------------------------------------------------- the fixtures --

/**
 * THE WIRE AS `serialiseBooking` ACTUALLY SENDS IT — which is to say WITHOUT
 * `guestName` and `guestPhone`, because api/src/services/booking.ts:128 emits
 * neither and `BookingSchema` declares both `.nullable()` without
 * `.optional()`.
 *
 * That omission is the point of the first describe block, and it is deliberate
 * in every fixture here: a base that supplied the keys would be a payload no
 * server produces, and this whole file would go green while the artist's day
 * failed to load against the real API.
 */
function wire(over: Record<string, unknown> = {}) {
  return {
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-1',
    branchId: 'BR-1',
    serviceId: 'SV-1',
    startsAt: '2026-09-28T09:00:00.000Z',
    endsAt: '2026-09-28T10:00:00.000Z',
    durationMin: 60,
    depositFils: 5000,
    status: 'deposit_held',
    source: 'app',
    changeableUntil: '2026-09-28T08:00:00.000Z',
    noShowReturnDueAt: '2026-09-28T11:00:00.000Z',
    rescheduledCount: 0,
    calendarSyncState: 'synced',
    memberName: 'Dana Al-Fahad',
    memberPhone: '+965 9912 4408',
    memberTier: 'gold',
    serviceName: 'Balayage',
    ...over,
  };
}

/** The front desk's walk-in: no member row, a name and a number on the booking. */
const GUEST = {
  id: 'BK-GUEST',
  source: 'merchant',
  depositFils: 0,
  memberId: null,
  memberName: null,
  memberPhone: null,
  memberTier: null,
  guestName: 'Noura Al-Mutairi',
  guestPhone: '+965 6677 8899',
};

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

function render(raw: unknown) {
  const booking = ArtistBookingSchema.parse(raw);
  const tree = BookingCard({ booking });
  const nodes = flatten(tree);
  return {
    booking,
    nodes,
    testIDs: nodes.map((n) => n.props.testID).filter((t): t is string => typeof t === 'string'),
    text: texts(tree),
    /** Everything the card would draw, as one string. */
    joined: texts(tree).join(' | '),
    labels: nodes
      .map((n) => n.props.accessibilityLabel)
      .filter((l): l is string => typeof l === 'string'),
  };
}

// == the payload the server actually sends ====================================

/**
 * THE BREAK THAT IS LIVE RIGHT NOW, PINNED SO THE TOLERANCE CANNOT BE TIDIED
 * AWAY. `guestName`/`guestPhone` are `.nullable()` and not `.optional()` on the
 * trunk schema, and no route emits them — so without the `.default(null)` on
 * this app's extension, `fetchMyBookings` rejects on EVERY booking and the
 * artist's day is empty. Reported to trunk; the one-word fix is theirs.
 */
describe('the wire as it stands today', () => {
  it('parses a body with no guest keys at all, which is every body the API sends', () => {
    const parsed = ArtistBookingSchema.parse(wire());
    expect(parsed.guestName).toBeNull();
    expect(parsed.guestPhone).toBeNull();
  });

  it('parses a guest row once the API starts serving one', () => {
    const parsed = ArtistBookingSchema.parse(wire(GUEST));
    expect(parsed.memberId).toBeNull();
    expect(parsed.guestName).toBe('Noura Al-Mutairi');
    expect(parsed.memberTier).toBeNull();
  });
});

// == the source pill ==========================================================

describe('the source pill renders all three sources distinctly', () => {
  /**
   * THE RATCHET. The map's keys are the contract's enum, read off the schema
   * rather than typed out here — so a fourth `source` fails this and the
   * compiler together, instead of falling through to "AVO app".
   */
  it('covers exactly the enum, with no value left to a default arm', () => {
    const contract = [...ArtistBookingSchema.shape.source.options].sort();
    expect(Object.keys(SOURCE_PILL).sort()).toEqual(contract);
    expect(contract).toEqual(['app', 'google_calendar', 'merchant']);
  });

  it('gives each source its own label, and no two the same', () => {
    const labels = Object.values(SOURCE_PILL).map((p) => p.label);
    expect(labels).toEqual([copy.bookingsSrcApp, copy.bookingsSrcGcal, copy.bookingsSrcMerchant]);
    expect(new Set(labels).size).toBe(3);
  });

  it('draws the right one on the card, for each of the three', () => {
    const expected = {
      app: 'AVO app',
      google_calendar: 'Google Calendar',
      merchant: 'Front desk',
    } as const;

    for (const [source, label] of Object.entries(expected)) {
      const r = render(wire({ id: `BK-${source}`, source }));
      const pill = r.nodes.find((n) => n.props.testID === `booking-source-${r.booking.id}`);
      expect(pill, `no source pill for ${source}`).toBeDefined();
      expect(texts(pill!.props.children)).toEqual([label]);
    }
  });

  /**
   * THE DEFECT, NAMED. A merchant booking must not be describable as the
   * customer's own — which is what "AVO app" says.
   */
  it('a front-desk booking is never labelled as the app', () => {
    const r = render(wire({ id: 'BK-M', source: 'merchant' }));
    expect(r.joined).toContain('Front desk');
    expect(r.joined).not.toContain('AVO app');
  });
});

// == the zero-deposit row =====================================================

describe('a booking that holds nothing says so, and claims no return', () => {
  /** `BookingSchema § status`: at 0 the label is "No-show", with no deposit in it. */
  it('a zero-deposit no-show does not claim a return', () => {
    const pill = pillFor({ status: 'no_show_returned', chargeVoided: false, depositFils: 0 });
    expect(pill?.label).toBe('No-show');
    expect(pill?.label).not.toContain('returned');
  });

  /** And the deposit-bearing one is untouched — design copy pinned as a literal. */
  it('a deposit-bearing no-show still says exactly what it said before', () => {
    const pill = pillFor({ status: 'no_show_returned', chargeVoided: false, depositFils: 5000 });
    expect(pill?.label).toBe('No-show · returned');
  });

  it('on the card, and the other statuses are not disturbed by the amount', () => {
    const zero = render(wire({ id: 'BK-NS0', status: 'no_show_returned', depositFils: 0 }));
    expect(zero.joined).toContain('No-show');
    expect(zero.joined).not.toContain('returned');

    const held = render(wire({ id: 'BK-NS5', status: 'no_show_returned' }));
    expect(held.joined).toContain('No-show · returned');

    // `completed` at 0 is a real shape — a merchant booking that was charged —
    // and it must still read "Paid" rather than being caught by the new branch.
    expect(render(wire({ id: 'BK-C0', status: 'completed', depositFils: 0 })).joined).toContain(
      'Paid',
    );
  });

  it('draws no deposit pill at zero, and still draws one above it', () => {
    const zero = render(wire({ id: 'BK-Z', depositFils: 0 }));
    expect(zero.testIDs).not.toContain('booking-deposit-BK-Z');
    expect(zero.joined).not.toContain('Deposit');
    expect(zero.joined).not.toContain('0.000');

    const held = render(wire({ id: 'BK-H' }));
    expect(held.testIDs).toContain('booking-deposit-BK-H');
    expect(held.joined).toContain('Deposit 5.000');
  });
});

// == the guest row ============================================================

describe('a guest booking renders the guest', () => {
  it('resolves the name off the booking when there is no member', () => {
    expect(clientName({ memberName: null, guestName: 'Noura Al-Mutairi' })).toBe(
      'Noura Al-Mutairi',
    );
    expect(clientName({ memberName: 'Dana Al-Fahad', guestName: null })).toBe('Dana Al-Fahad');
    // Neither is not a shape the contract allows, and it must not be "undefined".
    expect(clientName({ memberName: null, guestName: null })).toBe('—');
  });

  it('draws the guest’s name, not a blank and not the word undefined', () => {
    const r = render(wire(GUEST));
    expect(r.joined).toContain('Noura Al-Mutairi');
    expect(r.joined).not.toContain('undefined');
    expect(r.joined).not.toContain('null');

    const nameNode = r.nodes.find((n) => n.props.testID === 'booking-name-BK-GUEST');
    expect(nameNode).toBeDefined();
    expect(texts(nameNode!.props.children)).toEqual(['Noura Al-Mutairi']);
  });

  it('gives her an avatar initial rather than an empty circle', () => {
    // The initial is drawn from the same resolved name; before the fix it came
    // off `memberName.trim()`, which on a guest row was a throw and not a blank.
    expect(render(wire(GUEST)).text).toContain('N');
  });

  /**
   * NO TIER, AND NOT `bronze`. The lowest rung is something a member earned by
   * opening an account; printing it for a walk-in is a loyalty claim with no row
   * behind it.
   */
  it('shows Guest in the tier slot, and names no tier', () => {
    const r = render(wire(GUEST));
    expect(r.joined).toContain('Guest');
    for (const tier of ['Bronze', 'Silver', 'Gold', 'Black']) {
      expect(r.joined).not.toContain(tier);
    }
    // And a member's row is unchanged.
    expect(render(wire()).joined).toContain('Gold');
  });

  it('reaches her on the number the booking carries', () => {
    const r = render(wire(GUEST));
    expect(r.labels).toContain('Call Noura Al-Mutairi');
    expect(r.labels).toContain('WhatsApp Noura Al-Mutairi');
  });

  /**
   * THE ERASURE GUARD STILL COMES FIRST. A guest number cannot be scrubbed by
   * `services/erasure.ts`, which only touches `member` — but the coalesce must
   * not become a way for a live number to stand in for a tombstone.
   */
  it('an erased member’s row does not fall through to a guest number', () => {
    const r = render(
      wire({
        id: 'BK-E',
        memberName: 'Deleted account',
        memberPhone: null,
        memberErased: true,
        guestPhone: '+965 6677 8899',
      }),
    );
    expect(r.joined).toContain(copy.bookingsPhoneErased);
    expect(r.joined).not.toContain('6677');
    expect(r.labels.some((l) => l.startsWith('Call'))).toBe(false);
  });
});
