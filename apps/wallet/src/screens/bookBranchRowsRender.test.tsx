// @vitest-environment jsdom

/**
 * THE BRANCH STEP AS ROWS — Aftab, 2026-09-29, through the real `BookScreen`:
 *
 *   "Book branch list should be same design wise as services list"
 *   "Remove all branches option in the select branch while booking"
 *
 * So the branch step draws the service step's own full-width rows (not the
 * horizontal chip strip it had), there is no "All branches" row in either
 * language, and every booking at a multi-branch salon picks a real branch — or
 * "Other artists", the group the API calls `unassigned` — before a service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "THE SAME COMPONENT" IS ASSERTED BY WHAT RENDERS, NOT BY A NAME
 * ─────────────────────────────────────────────────────────────────────────────
 * jsdom does not lay out, so "full width" cannot be measured. What can be
 * pinned is that the branch row and the service row come out of one shell:
 * react-native-web compiles a style array to atomic class names, so two rows
 * drawn from the same `StyleSheet` entries carry the same `className`, and
 * their titles do too. A chip, a copy of the row with one padding changed, or a
 * strip container all produce a different one. The list container is compared
 * the same way, which is what says "a vertical list of rows" rather than "a
 * horizontal `ScrollView`".
 *
 * Mocked as `bookEntryRender.test.tsx` mocks, for the reasons it gives.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  { id: 'SV-1', salonId: 'SAL-AMARA', name: 'Cut & style', nameAr: 'قص وتصفيف', priceFils: 12000, active: true, image: null, artistIds: ['AR-1', 'AR-2', 'AR-3'] },
  { id: 'SV-2', salonId: 'SAL-AMARA', name: 'Blow-dry', nameAr: 'سشوار', priceFils: 8000, active: true, image: null, artistIds: ['AR-1', 'AR-2', 'AR-3'] },
];

const artist = (id: string): BookableArtist =>
  ({ id, salonId: 'SAL-AMARA', name: id, nameAr: null, availabilityLive: false }) as BookableArtist;
const ROSTER = [artist('AR-1'), artist('AR-2'), artist('AR-3')];

/** KWC has one artist, SAL has one, one is unassigned. */
function serveRoster() {
  getArtists.mockImplementation((_s: string, branch?: string) => {
    if (branch === 'unassigned') return Promise.resolve([artist('AR-3')]);
    if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
    if (branch === SAL.id) return Promise.resolve([artist('AR-2')]);
    return Promise.resolve(ROSTER);
  });
}

function draw(salon: Salon, lang: Language = 'en') {
  return render(
    <LanguageProvider initial={lang}>
      <BookScreen
        salon={salon}
        member={MEMBER}
        memberFetchedAt={null}
        onHome={vi.fn()}
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
const isSelected = (id: string) => {
  const el = screen.getByTestId(id);
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
};
/** Every branch-step row, in DOM order, by its id suffix. */
const branchRowIds = () =>
  Array.from(document.querySelectorAll('[data-testid^="book-branch-"]'))
    .map((el) => el.getAttribute('data-testid')!.replace('book-branch-', ''))
    .filter((id) => id !== 'empty' && id !== 'rows');
/** The title inside a row: its first leaf element, which is the name in both rows. */
const titleOf = (id: string) =>
  Array.from(screen.getByTestId(id).querySelectorAll('*')).find(
    (el) => el.children.length === 0 && (el.textContent ?? '') !== '',
  )!;

async function onBranchStep(lang: Language = 'en') {
  draw(salonWith([KWC, SAL]), lang);
  await waitFor(() => expect(screen.getByTestId(`book-branch-${KWC.id}`)).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue(SERVICES);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [] });
  serveRoster();
});

afterEach(cleanup);

// ═══════════════════════════════════════════ rows, the service list's own ══

describe('the branch step is the service list, design-wise', () => {
  it('draws each branch with the same row, the same title and the same list container as a service', async () => {
    await onBranchStep();
    const branchRow = screen.getByTestId(`book-branch-${KWC.id}`);
    const branchRowClass = branchRow.className;
    const branchListClass = branchRow.parentElement!.className;
    const branchTitleClass = titleOf(`book-branch-${KWC.id}`).className;
    expect(branchRow.textContent).toBe(KWC.name);

    fireEvent.click(branchRow);
    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByTestId('book-service-SV-1')).toBeTruthy());

    const serviceRow = screen.getByTestId('book-service-SV-1');
    // Both read UNSELECTED: the branch row before its tap, SV-1 before any.
    expect(branchRowClass).toBe(serviceRow.className);
    expect(branchListClass).toBe(serviceRow.parentElement!.className);
    expect(branchTitleClass).toBe(titleOf('book-service-SV-1').className);
  });

  it('a selected branch looks exactly like a selected service', async () => {
    await onBranchStep();
    fireEvent.click(screen.getByTestId(`book-branch-${KWC.id}`));
    await waitFor(() => expect(isSelected(`book-branch-${KWC.id}`)).toBe(true));
    const selectedBranchClass = screen.getByTestId(`book-branch-${KWC.id}`).className;

    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByTestId('book-service-SV-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('book-service-SV-1'));
    await waitFor(() => expect(isSelected('book-service-SV-1')).toBe(true));
    expect(screen.getByTestId('book-service-SV-1').className).toBe(selectedBranchClass);
  });

  /** SOURCE ASSERTION, labelled as such: the step no longer draws a strip. */
  it('BranchStep draws no horizontal ScrollView and no BranchChip', () => {
    const src = fs.readFileSync(path.join(__dirname, 'BookScreen.tsx'), 'utf8');
    const start = src.indexOf('function BranchStep(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    expect(body).not.toMatch(/\bhorizontal\b/);
    expect(body).not.toMatch(/BranchChip/);
    expect(body).toMatch(/BranchRow/);
  });
});

// ═══════════════════════════════════════════════════ no "All branches" ══

describe('there is no "All branches" choice, in either language', () => {
  it.each<[Language, string]>([
    ['en', 'All branches'],
    ['ar', 'كل الفروع'],
  ])('%s: branches in order, Other artists last, and nothing that means all', async (lang, allLabel) => {
    await onBranchStep(lang);
    await waitFor(() => expect(screen.getByTestId('book-branch-unassigned')).toBeTruthy());
    expect(branchRowIds()).toEqual([KWC.id, SAL.id, 'unassigned']);
    expect(screen.queryByTestId('book-branch-all')).toBeNull();
    expect(screen.queryByText(allLabel)).toBeNull();
    expect(document.body.textContent).not.toContain(allLabel);
  });

  it('nothing is chosen when the step paints, so Continue waits for her', async () => {
    await onBranchStep();
    await waitFor(() => expect(screen.getByTestId('book-branch-unassigned')).toBeTruthy());
    for (const id of branchRowIds()) expect(isSelected(`book-branch-${id}`)).toBe(false);
    expect(isDisabled('book-next')).toBe(true);
  });

  it('the empty-branch panel does not tell her to choose All branches', async () => {
    getArtists.mockImplementation((_s: string, branch?: string) => {
      if (branch === 'unassigned') return Promise.resolve([artist('AR-3')]);
      if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
      if (branch === SAL.id) return Promise.resolve([]);
      return Promise.resolve(ROSTER);
    });
    await onBranchStep();
    fireEvent.click(screen.getByTestId(`book-branch-${SAL.id}`));
    await waitFor(() => expect(screen.getByTestId('book-branch-empty')).toBeTruthy());
    expect(screen.getByText(en.branchEmptyTitle)).toBeTruthy();
    expect(screen.queryByText(en.branchEmptyBody)).toBeNull();
    expect(isDisabled('book-next')).toBe(true);
  });
});

// ═══════════════════════════════════════════════ selecting, and skipping ══

describe('choosing a branch', () => {
  it('selects the row, filters the roster to it, and Continue advances to services', async () => {
    await onBranchStep();
    expect(count()).toBe(en.bookStep(1, 5));
    fireEvent.click(screen.getByTestId(`book-branch-${SAL.id}`));
    await waitFor(() => expect(isSelected(`book-branch-${SAL.id}`)).toBe(true));
    expect(isSelected(`book-branch-${KWC.id}`)).toBe(false);
    await waitFor(() =>
      expect(getArtists).toHaveBeenCalledWith('SAL-AMARA', SAL.id, expect.anything()),
    );

    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByText(en.chooseService)).toBeTruthy());
    expect(count()).toBe(en.bookStep(2, 5));
  });

  it('Other artists keeps its note, and only while it is chosen', async () => {
    await onBranchStep();
    await waitFor(() => expect(screen.getByTestId('book-branch-unassigned')).toBeTruthy());
    expect(screen.getByTestId('book-branch-unassigned').textContent).toBe(en.branchFilterOther);
    expect(screen.queryByText(en.branchFilterOtherNote)).toBeNull();
    fireEvent.click(screen.getByTestId('book-branch-unassigned'));
    await waitFor(() => expect(screen.getByText(en.branchFilterOtherNote)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`book-branch-${KWC.id}`));
    await waitFor(() => expect(screen.queryByText(en.branchFilterOtherNote)).toBeNull());
  });

  it('a single-branch salon skips the step: services first, four steps, no branch rows', async () => {
    draw(salonWith([KWC]));
    expect(screen.getByText(en.chooseService)).toBeTruthy();
    expect(count()).toBe(en.bookStep(1, 4));
    await waitFor(() => expect(screen.getByTestId('book-service-SV-1')).toBeTruthy());
    expect(branchRowIds()).toEqual([]);
    expect(getArtists.mock.calls.every(([, branch]) => branch === undefined)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════ Arabic, RTL ══════

describe('the branch rows in Arabic — non-negotiable #12', () => {
  it('reads right-to-left, names each branch in Arabic, and keeps the feminine Other artists', async () => {
    await onBranchStep('ar');
    await waitFor(() => expect(screen.getByTestId('book-branch-unassigned')).toBeTruthy());
    expect(document.documentElement.dir).toBe('rtl');
    // Order is the reading order; mirroring is the layout's job, not a reversal.
    expect(branchRowIds()).toEqual([KWC.id, SAL.id, 'unassigned']);
    expect(screen.getByTestId(`book-branch-${KWC.id}`).textContent).toBe(KWC.nameAr);
    expect(screen.getByTestId(`book-branch-${SAL.id}`).textContent).toBe(SAL.nameAr);
    expect(screen.getByTestId('book-branch-unassigned').textContent).toBe(ar.branchFilterOther);
    expect(ar.branchFilterOther).toBe('مصففات أخريات');

    fireEvent.click(screen.getByTestId('book-branch-unassigned'));
    await waitFor(() => expect(screen.getByText(ar.branchFilterOtherNote)).toBeTruthy());
    await waitFor(() => expect(isDisabled('book-next')).toBe(false));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByText(ar.chooseService)).toBeTruthy());
    expect(count()).toBe('الخطوة ٢ من ٥');
  });

  /** SOURCE ASSERTION: the shared row is a logical row, so RTL mirrors it. */
  it('the shared option row is a logical row with no physical left/right', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'booking', 'BookingParts.tsx'),
      'utf8',
    );
    const row = src.slice(src.indexOf('  optionRow: {'), src.indexOf('  optionRowOn:'));
    expect(row).toMatch(/flexDirection: 'row'/);
    expect(row).not.toMatch(/row-reverse|\b(left|right|marginLeft|marginRight|paddingLeft|paddingRight):/);
  });
});
