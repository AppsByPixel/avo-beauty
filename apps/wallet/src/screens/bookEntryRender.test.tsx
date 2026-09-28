// @vitest-environment jsdom

/**
 * W1, RENDERED — "In book, it should be branch selection then service, then
 * staff", through the real `BookScreen`.
 *
 * `bookingSteps.test.tsx` pins the machine. This file pins what she SEES, which
 * the machine alone cannot: that the entry gate paints no counter and no
 * service rows, that its failure offers a working retry, that Back leaves from
 * whichever step is first, that an empty branch is said under the chips with
 * Continue held — and the Arabic layout (non-negotiable #12).
 *
 * Mocked: the wire (`api/booking`, `api/topups`, `platform/gateway`) and
 * `react-native-svg`, for the reason `cartTopUpBalanceRender.test.tsx` gives:
 * the chain reaches untranspiled Flow and the file would not collect.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT jsdom CANNOT SAY, AND SO WHAT THE RTL SPECS ASSERT INSTEAD
 * ─────────────────────────────────────────────────────────────────────────────
 * jsdom does not lay out, so "the progress fill starts at the right edge in
 * Arabic" cannot be measured here. What can be pinned is the MECHANISM, which
 * `i18n/rtl.ts` records was measured in a browser: the document direction is
 * `rtl`, the header is a logical `row` (never `row-reverse`), and the fill is
 * `alignSelf: 'flex-start'` with no physical `left`/`right`. The last two are
 * source assertions and are labelled as such, the same way
 * `bellRender.test.tsx` labels its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookableArtist, Language, Member, Salon } from '@avo/types';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

const { getServices, getArtists, getAvailability } = vi.hoisted(() => ({
  getServices: vi.fn(),
  getArtists: vi.fn(),
  getAvailability: vi.fn(),
}));
vi.mock('../api/booking', () => ({
  getServices,
  getArtists,
  getAvailability,
  createBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  getBookings: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));
vi.mock('../platform/gateway', () => ({ openGateway: vi.fn() }));

/* eslint-disable import/first */
import { BookScreen } from './BookScreen';
import { LanguageProvider } from '../i18n/language';
import { ApiError } from '../api/client';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

// --------------------------------------------------------------- fixtures --

const KWC = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const SAL = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };

const salonWith = (branches: Array<typeof KWC>): Salon =>
  ({
    id: 'SAL-AMARA',
    timezone: 'Asia/Kuwait',
    depositFils: 5000,
    branches,
    modules: { booking: true },
  }) as unknown as Salon;

const MEMBER = { balanceFils: 25000, tier: 'silver' } as unknown as Member;

const SERVICES = [
  { id: 'SV-1', salonId: 'SAL-AMARA', name: 'Cut & style', nameAr: 'قص وتصفيف', priceFils: 12000, active: true, image: null },
];

const artist = (id: string): BookableArtist =>
  ({ id, salonId: 'SAL-AMARA', name: id, nameAr: null, availabilityLive: false }) as BookableArtist;
const ROSTER = [artist('AR-1'), artist('AR-2'), artist('AR-3')];

/** KWC has one artist, SAL has nobody, two are unassigned. */
function serveRoster() {
  getArtists.mockImplementation((_s: string, branch?: string) => {
    if (branch === 'unassigned') return Promise.resolve([artist('AR-2'), artist('AR-3')]);
    if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
    if (branch === SAL.id) return Promise.resolve([]);
    return Promise.resolve(ROSTER);
  });
}

/** Holds the `?branch=unassigned` read open; everything else answers at once. */
function holdSplit() {
  let release: (rows: BookableArtist[]) => void = () => {};
  let fail: (err: unknown) => void = () => {};
  getArtists.mockImplementation((_s: string, branch?: string) => {
    if (branch === 'unassigned') {
      return new Promise<BookableArtist[]>((res, rej) => {
        release = res;
        fail = rej;
      });
    }
    if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
    return Promise.resolve(ROSTER);
  });
  return { release: (r: BookableArtist[]) => release(r), fail: (e: unknown) => fail(e) };
}

const onHome = vi.fn();

function draw(salon: Salon, lang: Language = 'en') {
  return render(
    <LanguageProvider initial={lang}>
      <BookScreen
        salon={salon}
        member={MEMBER}
        memberFetchedAt={null}
        onHome={onHome}
        onBooked={vi.fn()}
        onToast={vi.fn()}
      />
    </LanguageProvider>,
  );
}

const count = () => screen.getByTestId('book-step-count').textContent;
const isDisabled = (id: string) => {
  const el = screen.getByTestId(id);
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
};

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue(SERVICES);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [] });
  serveRoster();
});

afterEach(cleanup);

// ═══════════════════════════════════════════════════════ the entry gate ══

describe('entry at a multi-branch salon, before the roster lands', () => {
  it('paints a skeleton with no counter, no service rows and no CTA — then the branch step', async () => {
    const split = holdSplit();
    draw(salonWith([KWC, SAL]));
    await waitFor(() => expect(getServices).toHaveBeenCalled());

    expect(screen.getByTestId('book-entry-loading')).toBeTruthy();
    expect(count()).toBe('');
    expect(screen.queryByText(en.chooseService)).toBeNull();
    expect(screen.queryByText(en.chooseBranch)).toBeNull();
    expect(screen.queryByTestId('book-next')).toBeNull();
    // The track is drawn and has no value: no fraction is claimed yet.
    expect(screen.getByTestId('book-progress').getAttribute('aria-valuenow')).toBeNull();

    await act(async () => {
      split.release([artist('AR-2')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(en.chooseBranch)).toBeTruthy());
    expect(count()).toBe(en.bookStep(1, 5));
    expect(screen.queryByTestId('book-entry-loading')).toBeNull();
    expect(screen.queryByText(en.chooseService)).toBeNull();
  });

  it('a failure at entry is the failure screen, and Try again recovers in place', async () => {
    const first = holdSplit();
    draw(salonWith([KWC, SAL]));
    await act(async () => {
      first.fail(new ApiError('offline', 'You are offline.', 'REF-1', null));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(en.offlineColdTitle)).toBeTruthy());
    expect(count()).toBe('');

    const second = holdSplit();
    fireEvent.click(screen.getByText(en.tryAgain));
    await waitFor(() => expect(screen.getByTestId('book-entry-loading')).toBeTruthy());

    await act(async () => {
      second.release([artist('AR-2')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(en.chooseBranch)).toBeTruthy());
    expect(count()).toBe(en.bookStep(1, 5));
  });

  it('Back from the gate leaves the flow', async () => {
    holdSplit();
    draw(salonWith([KWC, SAL]));
    fireEvent.click(screen.getByTestId('book-back'));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════ back, rendered ══

describe('Back leaves from the first step, whichever it is', () => {
  it('multi-branch: service steps back to the branch, and the branch leaves', async () => {
    draw(salonWith([KWC, SAL]));
    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByText(en.chooseService)).toBeTruthy());
    expect(count()).toBe(en.bookStep(2, 5));

    fireEvent.click(screen.getByTestId('book-back'));
    await waitFor(() => expect(screen.getByText(en.chooseBranch)).toBeTruthy());
    expect(onHome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('book-back'));
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it('single-branch: opens on the service at "Step 1 of 4" at once, and Back leaves', async () => {
    draw(salonWith([KWC]));
    // No gate: the label and the count are there on the first paint.
    expect(screen.queryByTestId('book-entry-loading')).toBeNull();
    expect(screen.getByText(en.chooseService)).toBeTruthy();
    expect(count()).toBe(en.bookStep(1, 4));

    fireEvent.click(screen.getByTestId('book-back'));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════ the empty branch ══

describe('an empty branch is said under the chips, and Continue is held', () => {
  it('shows the empty panel on the branch step and keeps Continue disabled until another chip', async () => {
    draw(salonWith([KWC, SAL]));
    await waitFor(() => expect(screen.getByTestId(`book-branch-${SAL.id}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`book-branch-${SAL.id}`));
    await waitFor(() => expect(screen.getByTestId('book-branch-empty')).toBeTruthy());
    expect(screen.getByText(en.branchEmptyBody)).toBeTruthy();
    expect(isDisabled('book-next')).toBe(true);
    // Still the branch step: the chips she needs are right above the panel.
    expect(count()).toBe(en.bookStep(1, 5));

    fireEvent.click(screen.getByTestId(`book-branch-${KWC.id}`));
    await waitFor(() => expect(screen.queryByTestId('book-branch-empty')).toBeNull());
    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
  });
});

// ═══════════════════════════════════════════════════ 8 · Arabic, RTL ══════

describe('the Book flow in Arabic — non-negotiable #12', () => {
  it('lays out right-to-left, and walks branch → service with the counter in Arabic', async () => {
    draw(salonWith([KWC, SAL]), 'ar');
    await waitFor(() => expect(isDisabled('book-next')).toBe(false));

    expect(document.documentElement.dir).toBe('rtl');
    // Same order as English — mirroring is layout, not a reordering of steps.
    // `ar.chooseBranch` IS STILL AN AR GAP (copy/types.ts § chooseBranch) and
    // renders the English label; since W1 it is the first label an Arabic
    // customer at a multi-branch salon reads. Reported, not guessed at here.
    expect(screen.getByText(ar.chooseBranch)).toBeTruthy();
    expect(count()).toBe(ar.bookStep(1, 5));
    expect(count()).toBe('الخطوة ١ من ٥');
    expect(screen.getByTestId('book-progress').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByTestId('book-progress').getAttribute('aria-valuemax')).toBe('5');
    // The branch chip speaks the branch's Arabic name.
    expect(screen.getByTestId(`book-branch-${KWC.id}`).textContent).toBe(KWC.nameAr);

    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByText(ar.chooseService)).toBeTruthy());
    expect(count()).toBe('الخطوة ٢ من ٥');
    expect(screen.getByTestId('book-progress').getAttribute('aria-valuenow')).toBe('2');
  });

  it('the entry gate in Arabic is the same gate: no counter, then ١ من ٥', async () => {
    const split = holdSplit();
    draw(salonWith([KWC, SAL]), 'ar');
    await waitFor(() => expect(screen.getByTestId('book-entry-loading')).toBeTruthy());
    expect(count()).toBe('');
    await act(async () => {
      split.release([artist('AR-2')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(count()).toBe('الخطوة ١ من ٥'));
  });

  /** SOURCE ASSERTIONS, labelled as such — see the header. */
  it('the header is a logical row, never row-reverse', () => {
    const src = fs.readFileSync(path.join(__dirname, 'BookScreen.tsx'), 'utf8');
    const header = src.slice(src.indexOf('  header: {'), src.indexOf('  backButton:'));
    expect(header).toMatch(/flexDirection: 'row'/);
    expect(header).not.toMatch(/row-reverse/);
  });

  it('the progress fill grows from the reading edge: flex-start, no physical left/right', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'booking', 'BookingParts.tsx'),
      'utf8',
    );
    const fill = src.slice(src.indexOf('  fill: {'), src.indexOf('\n', src.indexOf('  fill: {')));
    expect(fill).toMatch(/alignSelf: 'flex-start'/);
    expect(fill).not.toMatch(/\b(left|right):/);
    const bar = src
      .slice(src.indexOf('export function ProgressBar'), src.indexOf('// ---', src.indexOf('export function ProgressBar')))
      // Code only: the component's own comment names `flex-end` to warn against it.
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(bar).not.toMatch(/lang === 'ar'|isRtl|row-reverse|flex-end/);
  });
});
