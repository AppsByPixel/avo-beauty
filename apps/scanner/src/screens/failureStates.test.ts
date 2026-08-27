/**
 * Two guarantees every fetching screen on this surface owes, and which nothing
 * asserted until row 365 was audited screen by screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SOURCE SCANS, for the reason `chargeStates.test.ts` sets out at length: there is
 * no renderer in this workspace — no jsdom, no testing-library, and
 * `react-test-renderer` is gone in React 19 — and adding one rewrites the
 * trunk-owned `pnpm-lock.yaml`, which is not a lane B call.
 *
 * And as there, a render test would aim at the wrong risk. Neither guarantee is
 * about a component drawing a value wrongly:
 *
 *   the dead-session rule   a 401 must reach `reportFailure`, which ends the
 *                           session so the shell can swap in the PIN screen. A
 *                           screen that handles it itself shows an alert whose
 *                           retry 401s for ever. Four screens had this; three had
 *                           it because somebody remembered.
 *   the offline rule        `offline` must be told apart from a server failure.
 *                           `ScheduleScreen` read TRUTHFULLY BY ACCIDENT — a
 *                           transport failure carries `message: 'No connection.'`
 *                           from api/client.ts, so the body said the right thing
 *                           under a title that said "We couldn't load that" — while
 *                           a 503/504 classifies as `offline` too and carries the
 *                           SERVER's message, blaming us for her signal.
 *
 * Truthful-by-accident is the class this build keeps finding, and it is invisible
 * to any test that only checks the common path.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '../copy/en';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

/**
 * The screens that talk to the server, and therefore owe both guarantees.
 *
 * NOT a glob over the directory, deliberately — the four screens excluded are
 * excluded for stated reasons, and a list that explains itself is the point:
 *
 *   HomeScreen    menu tiles, no request.
 *   ScanScreen    the camera. Its states are camera-permission states; the scan
 *                 result is handled by ScannerFlow.
 *   ResultScreen  renders a charge already completed and passed in.
 *   EnrolScreen   "NOT A DESIGNED SCREEN" — writes a local device binding only,
 *                 no network call at all.
 *
 * ScannerFlow is the shell rather than a screen; it already calls `reportFailure`
 * and owns the swap to PIN.
 */
const FETCHING_SCREENS = [
  'BookingsScreen.tsx',
  'ChargesScreen.tsx',
  'LookupScreen.tsx',
  'MemberScreen.tsx',
  'ScheduleScreen.tsx',
] as const;

/**
 * The door itself. `PinScreen` fetches and owes the OFFLINE guarantee — it has it,
 * `err.kind === 'offline'` → `copy.offlineTitle` — but it must NOT call
 * `reportFailure`, because that ends the session in order to show the PIN screen
 * and this IS the PIN screen. Reporting here would be circular.
 *
 * Its own category rather than an exclusion, so the offline half is still asserted.
 */
const SIGN_IN_SCREEN = 'PinScreen.tsx';

const EXCLUDED = ['HomeScreen.tsx', 'ScanScreen.tsx', 'ResultScreen.tsx', 'EnrolScreen.tsx'];

describe('the screen census stays honest', () => {
  /**
   * The guard on the list above. A screen added to this directory joins neither
   * list silently — it fails here until somebody classifies it, which is the only
   * moment the classification is cheap.
   */
  it('accounts for every screen in the directory, one list or the other', () => {
    const onDisk = readdirSync(__dirname)
      .filter((f) => f.endsWith('Screen.tsx'))
      .sort();
    const accounted = [...FETCHING_SCREENS, SIGN_IN_SCREEN, ...EXCLUDED].sort();
    expect(onDisk).toEqual(accounted);
  });
});

describe('a dead session drops to PIN rather than becoming a screen error', () => {
  it.each(FETCHING_SCREENS)('%s reports a failed request to the session', (name) => {
    expect(read(name)).toContain('reportFailure');
  });

  /**
   * ORDER IS THE SPEC, not a detail. `reportFailure` has to run before the screen
   * classifies anything, because a 401 carries no recognisable `code` and its
   * message is the raw "Sign in to continue." — the exact string the session
   * module's header records being printed at a counter under a dead Charge button.
   * Scoped to the two screens fixed in this slice; the other three predate it and
   * are asserted only on presence above.
   */
  it.each(['LookupScreen.tsx', 'ScheduleScreen.tsx'])(
    '%s reports it BEFORE it inspects the error',
    (name) => {
      const src = read(name);
      const reported = src.indexOf('if (reportFailure(err)) return;');
      const inspected = src.indexOf('err instanceof ApiError');
      expect(reported).toBeGreaterThan(-1);
      expect(inspected).toBeGreaterThan(-1);
      expect(reported).toBeLessThan(inspected);
    },
  );
});

describe('the sign-in screen is the one exception, and only to one rule', () => {
  it('does not report a dead session — it IS the remedy for one', () => {
    expect(read(SIGN_IN_SCREEN)).not.toContain('reportFailure');
  });

  it('still tells her connection apart from a wrong PIN', () => {
    const src = read(SIGN_IN_SCREEN);
    expect(src).toMatch(/kind === 'offline'/);
    // A dead connection and a wrong PIN must not read the same.
    expect(src).toMatch(/kind === 'refused'/);
  });
});

describe('her connection is told apart from our failure', () => {
  it.each([...FETCHING_SCREENS, SIGN_IN_SCREEN])(
    '%s has a branch on the offline kind',
    (name) => {
      expect(read(name)).toMatch(/kind === 'offline'/);
    },
  );

  /**
   * The half that catches the regression rather than the presence. `offlineBanner`
   * — "No connection · showing your last update" — is a STALE-DATA sentence, and
   * three screens shipped it on cold loads where nothing was on screen to show.
   * `OfflineBanner`'s `label` is required now precisely so this cannot recur
   * silently, and this asserts the other direction: no screen reaches for that
   * string by name.
   */
  it.each(FETCHING_SCREENS)('%s does not use the stale-data sentence', (name) => {
    expect(read(name)).not.toMatch(/copy\.offlineBanner/);
  });

  /**
   * `ScheduleScreen` is a SAVE path, so "Nothing is lost" is a literal claim about
   * this screen and not a comfort: the draft week is dropped only in the success
   * branch, so an unsaved week survives the failure and is still on screen behind
   * the alert.
   */
  it('ScheduleScreen keeps the draft when a save fails', () => {
    const src = read('ScheduleScreen.tsx');
    expect(src).toContain('copy.offlineColdBody');
    expect(copy.offlineColdBody).toContain('Nothing is lost');
    // The draft is cleared in the success path only — never in the catch.
    const catchStart = src.indexOf('} catch (err) {');
    expect(catchStart).toBeGreaterThan(-1);
    expect(src.slice(catchStart)).not.toContain('setDraftWeek(null)');
  });

  /**
   * The sentence must exist in both places it is claimed to. A screen naming a
   * copy key that the dictionary lost renders `undefined` at a counter.
   */
  it('names a sentence the dictionary actually has', () => {
    expect(copy.offlineTitle).toBe('No connection');
    expect(copy.offlineColdBody).toBeTruthy();
    // Not the charge-specific one, which is wrong for a list or a save.
    expect(copy.offlineColdBody).not.toContain('take a charge');
  });
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * A REFUSAL SAYS THE RIGHT THING, OR IT IS WORSE THAN NO SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /artists/me` and `GET /artists/me/bookings` both answer `404
 * not_an_artist` through the same `requireOwnArtist`, so for a long time both
 * screens rendered the same two strings. Those strings were written for
 * bookings: "This account has no calendar" / "…no appointments of its own. A
 * manager can add you to the team in the merchant dashboard."
 *
 * On the schedule screen every clause of that was wrong. Wrong noun twice —
 * this screen is about HOURS, and the reader arrived from a tile that says "Set
 * the hours you're available to book". And the remedy misfires on exactly the
 * account most likely to see it: the refusal is what a MANAGER gets, because a
 * manager is who taps that tile out of curiosity, and she is already on the
 * team. Confidently-worded dead end, and it survived because nothing asserted
 * the wording — only that the state existed.
 *
 * Which is the same class as `offline` reading truthfully-by-accident above.
 * Presence tests do not catch it, so these assert the WORDS.
 *
 * DECISIONS 53 is why this matters more than it looks: the padlock on this tile
 * was rejected, so the refusal one tap later IS the whole courtesy. There is no
 * pre-tap signal behind which a bad sentence could hide.
 */
describe('the schedule refusal is about hours, not somebody else\'s screen', () => {
  const src = read('ScheduleScreen.tsx');
  const code = codeOf(src);

  /**
   * Asserted against the CODE, not the file. The first version of this checked
   * the whole source and failed immediately — on the comment three lines above
   * `setNotArtist` that explains which wording this screen used to render. A test
   * that cannot survive a screen naming its own history is the wrong test in a
   * codebase whose headers are mostly history, and rewording the comment to
   * dodge a string match would have been the tail wagging the dog.
   */
  it('does not reach for the bookings pair', () => {
    expect(code).not.toContain('copy.notArtistTitle');
    expect(code).not.toContain('copy.notArtistBody');
    // The guard on the guard: stripping comments must not strip everything.
    expect(code).toContain('copy.scheduleNotArtistTitle');
  });

  it('shows the server sentence as the body, the way the 409s beside it do', () => {
    // `Refusal body={notArtist}` — the state holds the message, not a boolean.
    expect(src).toMatch(/body=\{notArtist\}/);
    expect(src).toContain('setNotArtist(refusalBody(err.message))');
    // Both catch sites, the read and the save — not just the one being edited.
    expect(src.match(/setNotArtist\(refusalBody\(err\.message\)\)/g)).toHaveLength(2);
  });

  it('never draws a title over a blank body', () => {
    /*
      The mirror at the bottom of this file is only evidence while it IS the
      screen's expression, so pin it. Without this line the comment down there
      claiming the two sides are asserted equal would be the same kind of
      confident-but-false note this whole slice is about.
    */
    expect(src).toContain('return message?.trim() || copy.scheduleNotArtistBody;');
    // A whitespace-only message is truthy, so `||` alone would pass '   ' through.
    expect(refusalBodyOf('')).toBe(copy.scheduleNotArtistBody);
    expect(refusalBodyOf('   ')).toBe(copy.scheduleNotArtistBody);
    expect(refusalBodyOf(undefined)).toBe(copy.scheduleNotArtistBody);
    expect(copy.scheduleNotArtistBody.trim()).not.toBe('');
    // And the server's sentence wins whenever there is one.
    expect(refusalBodyOf('It has no hours to set.')).toBe('It has no hours to set.');
  });

  /**
   * THE ASSERTION THIS SLICE EXISTS FOR. Both halves failed before the fix:
   * "appointments" came from `notArtistBody`, and so did the team advice.
   */
  it('says hours, not appointments, and sends nobody to join a team', () => {
    const shown = [copy.scheduleNotArtistTitle, copy.scheduleNotArtistBody].join(' ');
    expect(shown).not.toMatch(/appointment/i);
    expect(shown).not.toMatch(/calendar/i);
    expect(shown).not.toMatch(/\bteam\b/i);
    expect(shown).toMatch(/hours/i);
  });

  /**
   * The pair it replaced is still correct on the screen it was written for, so
   * this fix must not have "tidied" it away — BookingsScreen would render
   * `undefined` at a counter.
   */
  it('leaves the bookings pair intact for the screen that owns it', () => {
    expect(read('BookingsScreen.tsx')).toContain('copy.notArtistTitle');
    expect(copy.notArtistTitle).toBe('This account has no calendar');
    expect(copy.notArtistBody).toMatch(/appointments of its own/);
  });
});

/**
 * Comments out, code in. Block comments and comment-only lines, which is every
 * form this directory actually uses — deliberately not a parser: the day a
 * screen puts `//` inside a string literal, this is a `grep` away from being
 * understood, whereas a hand-rolled tokeniser would not be.
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * `refusalBody` is module-private in ScheduleScreen — exporting it to be tested
 * would widen the screen's surface for the test's convenience, and the rule it
 * encodes is one line. Mirrored here, with the source asserted above to be the
 * same expression, so a change to either side without the other fails.
 */
function refusalBodyOf(message: string | undefined): string {
  return message?.trim() || copy.scheduleNotArtistBody;
}
