/**
 * DECISIONS.md #100 on the scanner — "a tombstone presented as a contact".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS ONE RENDERS, AND `chargeStates.test.ts` SAYS THAT IS IMPOSSIBLE HERE
 * ═════════════════════════════════════════════════════════════════════════════
 * That file's header is right about the facts and this test does not contradict
 * them: there is no jsdom in this package, no testing-library, and
 * `react-test-renderer` is gone in React 19. Linking the dashboard's copies in
 * would rewrite the trunk-owned `pnpm-lock.yaml`, which is still not a lane B
 * call.
 *
 * What it is wrong about is the conclusion, and only for THIS defect. Its two
 * rules are about a row disappearing and a button appearing, and a source scan
 * catches both. This one is about a value REACHING an `onPress` — and the whole
 * bug is that the value looked fine at every point a scan can read. A grep for
 * `wa.me` finds the string in the shipped source whether the guard works or
 * not; it cannot tell you that `digits` was null when the handler was built.
 * The only honest question is "what does the card actually produce for an
 * erased booking", and that has to be produced.
 *
 * SO IT IS PRODUCED WITHOUT A RENDERER, AND WITHOUT A DEPENDENCY. `BookingCard`
 * is a function that takes props and returns a React element tree — plain
 * objects. Two mocks are all that stands between here and calling it:
 *
 *   `react-native`  is Flow source that will not load under Node. It is
 *                   replaced with host markers — `View`, `Text`, `Pressable`
 *                   are string tags, `StyleSheet.create` is identity, and
 *                   `Linking.openURL` is a spy. Nothing about the card's LOGIC
 *                   lives in those; they are the tags it hangs its props on.
 *
 *   `react`         is real except for `useCallback`, which the card uses once
 *                   and which throws outside a render because the dispatcher is
 *                   null. `createContext` and friends stay real — `../state/session`
 *                   builds a context at module load and must still work. JSX
 *                   itself comes from `react/jsx-runtime`, a different module,
 *                   untouched: the elements below are the ones React would make.
 *
 * This is a narrow harness and it is deliberately not a general one. It proves
 * one thing: for an erased booking, no node in the tree carries a `tel:` or a
 * `wa.me`, and the `+990` digits appear nowhere as text. It does that by
 * WALKING THE TREE AND FIRING EVERY `onPress` IT FINDS, so a button that is
 * merely styled away, or moved, or renamed, still fails this test.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ------------------------------------------------------------ the two mocks --

const openURL = vi.fn((_url: string) => Promise.resolve(true));

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
    Linking: { openURL: (url: string) => openURL(url) },
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

/*
  `react-native-svg` ships untranspiled source that Node will not parse — it is
  what `../components/States` reaches through. The card under test draws no SVG;
  these are markers so the module graph loads.
*/
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
  // `useCallback` is the card's only hook and it needs a dispatcher we do not
  // have. Identity is the correct stand-in: the card's handler is rebuilt every
  // render anyway, and nothing under test depends on its referential stability.
  return { ...(actual as object), useCallback: (fn: unknown) => fn };
});

// Imported AFTER the mocks, which is what `vi.mock`'s hoisting guarantees.
const { BookingCard } = await import('./BookingsScreen');
const { ArtistBookingSchema } = await import('../api/artist');
const { copy } = await import('../copy/en');

// ------------------------------------------------------------- the fixture --

/**
 * The wire, not a hand-built object — so the schema change is under test too.
 *
 * `TOMBSTONE` is what `api/src/services/erasure.ts` writes: the name literal
 * from its own `TOMBSTONE_NAME`, and `+990` with twelve digits after it. The
 * digits here are the ones from the brief, kept verbatim so a grep for the
 * fabricated number lands on the test that forbids it.
 */
const TOMBSTONE_DIGITS = '990418702935514';

function wire(over: Record<string, unknown>) {
  return {
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-1',
    branchId: 'BR-1',
    serviceId: 'SV-1',
    startsAt: '2026-09-11T09:00:00.000Z',
    endsAt: '2026-09-11T10:00:00.000Z',
    durationMin: 60,
    depositFils: 5000,
    status: 'completed',
    source: 'app',
    changeableUntil: '2026-09-10T09:00:00.000Z',
    noShowReturnDueAt: '2026-09-11T11:00:00.000Z',
    rescheduledCount: 0,
    calendarSyncState: 'synced',
    memberName: 'Dana Al-Fahad',
    memberPhone: '+965 9912 4408',
    memberTier: 'gold',
    serviceName: 'Balayage',
    ...over,
  };
}

/** Lane A's payload for an erased member: null phone, flag true, name kept. */
const erasedWire = wire({
  id: 'BK-ERASED',
  memberName: 'Deleted account',
  memberPhone: null,
  memberErased: true,
});

/** Today's payload, before lane A merges. No `memberErased` key at all. */
const liveWire = wire({ id: 'BK-LIVE' });

/**
 * The case that has no contract and can still arrive: the tombstone STRING,
 * with no flag, because lane A has not landed and the API is still joining
 * `member` live. This is the one the `+990` sentinel was actually reaching.
 */
const preLaneAWire = wire({
  id: 'BK-PRELANEA',
  memberName: 'Deleted account',
  memberPhone: `+${TOMBSTONE_DIGITS}`,
});

// ------------------------------------------------------------- the walker --

interface Node {
  type: unknown;
  props: Record<string, unknown>;
}

/** Every element in the tree, depth-first. Arrays, nulls and strings survive. */
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

/** Every string and number the card would draw, in order. */
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

/** The tree, plus everything an artist could reach by touching it. */
function render(raw: unknown) {
  openURL.mockClear();
  const booking = ArtistBookingSchema.parse(raw);
  const tree = BookingCard({ booking });
  const nodes = flatten(tree);
  const pressed: string[] = [];
  for (const n of nodes) {
    const onPress = n.props.onPress;
    if (typeof onPress === 'function') {
      (onPress as () => void)();
      pressed.push(String(n.props.testID ?? n.props.accessibilityLabel ?? '(unlabelled)'));
    }
  }
  return {
    booking,
    nodes,
    pressed,
    /** Every URL the card handed to the OS when all of its handlers fired. */
    opened: openURL.mock.calls.map(([url]) => url),
    testIDs: nodes.map((n) => n.props.testID).filter((t): t is string => typeof t === 'string'),
    text: texts(tree),
  };
}

const serialise = (r: ReturnType<typeof render>) =>
  [
    `testIDs : ${JSON.stringify(r.testIDs)}`,
    `text    : ${JSON.stringify(r.text)}`,
    `pressed : ${JSON.stringify(r.pressed)}`,
    `opened  : ${JSON.stringify(r.opened)}`,
  ].join('\n');

beforeEach(() => openURL.mockClear());

// ------------------------------------------------------------ the schema ----

describe('ArtistBookingSchema takes both payloads', () => {
  /**
   * THE URGENT HALF. `memberPhone: z.string()` does not degrade when lane A
   * starts sending `null` — it throws, `fetchMyBookings` rejects, and the
   * artist's whole day renders as an error. A privacy fix that ships after the
   * contract lands is a privacy fix that shipped as an outage first.
   */
  it('parses lane A’s null phone rather than rejecting the whole page', () => {
    const parsed = ArtistBookingSchema.parse(erasedWire);
    expect(parsed.memberPhone).toBeNull();
    expect(parsed.memberErased).toBe(true);
    expect(parsed.memberName).toBe('Deleted account');
  });

  /** And is still green on the payload the API serves today, without the flag. */
  it('defaults memberErased to false when the key is absent', () => {
    const parsed = ArtistBookingSchema.parse(liveWire);
    expect(parsed.memberErased).toBe(false);
    expect(parsed.memberPhone).toBe('+965 9912 4408');
  });

  /** A string phone is still required to BE a string. `.nullable()`, not `.optional()`. */
  it('still refuses a missing phone key', () => {
    const { memberPhone: _drop, ...noPhone } = erasedWire;
    expect(() => ArtistBookingSchema.parse(noPhone)).toThrow();
  });
});

// -------------------------------------------------------------- the card ----

describe('the erased card offers no way to reach nobody', () => {
  it('renders neither a tel: nor a wa.me, even when every handler is fired', () => {
    const r = render(erasedWire);
    console.log('\n--- erased booking ---\n' + serialise(r));

    expect(r.testIDs).not.toContain('booking-call-BK-ERASED');
    expect(r.testIDs).not.toContain('booking-wa-BK-ERASED');
    // The strong form: nothing left in the tree opens anything at all.
    expect(r.opened).toEqual([]);
    expect(r.opened.some((u) => u.startsWith('tel:'))).toBe(false);
    expect(r.opened.some((u) => u.includes('wa.me'))).toBe(false);
  });

  it('prints no digits — a number read off a card is typed into a handset', () => {
    const r = render(erasedWire);
    const joined = r.text.join(' | ');
    expect(joined).not.toContain('+990');
    expect(joined).not.toContain(TOMBSTONE_DIGITS);
    // Nor any bare run of digits long enough to be a phone number. `60 min`,
    // `5.000` and the clock label are all short; a phone is not.
    expect(joined.match(/\d[\d\s-]{6,}/)).toBeNull();
  });

  it('keeps the tombstone name, and says plainly that the number is gone', () => {
    const r = render(erasedWire);
    expect(r.text).toContain('Deleted account');
    expect(r.text).toContain(copy.bookingsPhoneErased);
    // The rest of the card is about the APPOINTMENT and is untouched.
    expect(r.text).toContain('Balayage');
    expect(r.text).toContain('Gold');
  });

  /**
   * The card must not crash on a null phone. Before the fix this was
   * `booking.memberPhone.replace(...)` inside render — which does not break one
   * card, it throws through `groupByDay` and takes the whole day screen down.
   */
  it('does not throw on a null phone', () => {
    expect(() => render(erasedWire)).not.toThrow();
  });

  /**
   * The belt to the flag's braces. Until lane A merges, the API still joins the
   * scrubbed row live and the phone arrives as the `+990` STRING with no flag.
   * The null guard cannot catch that one; nothing can, on the client, without
   * pattern-matching a sentinel — which this deliberately does NOT do.
   *
   * So this test asserts the honest state of affairs rather than a fix that is
   * not ours to make: the card behaves normally, and the exposure closes when
   * lane A lands. It is here so that the day the API changes, the line below
   * fails and somebody reads this paragraph.
   */
  it('documents the pre-lane-A gap: an unflagged tombstone still renders', () => {
    const r = render(preLaneAWire);
    expect(r.opened).toContain(`https://wa.me/${TOMBSTONE_DIGITS}`);
  });
});

describe('a live booking is entirely unchanged', () => {
  it('still carries both buttons, and both still open the real number', () => {
    const r = render(liveWire);
    console.log('\n--- live booking ---\n' + serialise(r));

    expect(r.testIDs).toContain('booking-call-BK-LIVE');
    expect(r.testIDs).toContain('booking-wa-BK-LIVE');
    expect(r.opened).toEqual(['tel:96599124408', 'https://wa.me/96599124408']);
    expect(r.text).toContain('+965 9912 4408');
    expect(r.text).not.toContain(copy.bookingsPhoneErased);
  });

  /**
   * `memberErased: false` with a real phone is the same card as no key at all.
   * Asserted because the guard reads the flag FIRST, and a truthiness slip
   * there would blank every card.
   */
  it('is the same card whether the flag is absent or explicitly false', () => {
    const absent = render(liveWire);
    const explicit = render(wire({ id: 'BK-LIVE', memberErased: false }));
    expect(explicit.testIDs).toEqual(absent.testIDs);
    expect(explicit.text).toEqual(absent.text);
    expect(explicit.opened).toEqual(absent.opened);
  });
});
