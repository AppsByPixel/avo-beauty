// @vitest-environment jsdom

/**
 * THE CUSTOMER BOOK, DRIVEN.
 *
 * `stateCensus.test.ts` proves this screen HAS the four-state vocabulary and a
 * pending paint. It cannot prove what a merchant actually reads, and on this
 * screen four things are not cosmetic:
 *
 *   1. AN ERASED CUSTOMER IS NOT CONTACTABLE, AND SHE IS STILL IN THE BOOK. Both
 *      halves, because each without the other is a defect: hiding her makes a
 *      settled charge trace to a customer who cannot be opened, and showing her
 *      with the `+990` tombstone hands a merchant digits that reach nobody. This
 *      lane has shipped the second failure twice — the fulfilment board's `tel:`
 *      link (DECISIONS.md #100) and the scanner's `wa.me` button — so it is
 *      asserted three ways: no anchor, no digits anywhere in the row, and the row
 *      present at all.
 *
 *   2. THE TWO EMPTIES DO NOT SHARE COPY. `AVO States.dc.html:199` is explicit —
 *      "Echo the query back and offer the escape. Distinct from 'no data at
 *      all'." A salon with 1,284 registrations told "No customers yet" because a
 *      search matched nothing is a claim about her business, not about her filter.
 *
 *   3. SEARCH IS THE SERVER'S. A client-side filter searches the 25 rows in hand
 *      and then reports "no customer matches" about a book it has never seen. The
 *      only way to know which one shipped is to look at the URL that left.
 *
 *   4. THE 403 IS NOT AN ERROR. A manager without `team` gets the server's own
 *      sentence and NO retry button, because an identical request produces an
 *      identical refusal and a retry is a lie about what she can do.
 *
 * DRIVEN THROUGH THE REAL HOOKS AND THE REAL PARSERS — `authedRequest` is the only
 * seam. `noShowMarkRender.test.tsx` mocks its data hooks wholesale, which is right
 * for a screen whose subject is a mutation; here the wire SHAPE is half the
 * subject, so a mock at the hook boundary would skip `parseCustomerBook` and prove
 * nothing about the field names Lane A chose to match `MemberContactWire`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** The salon comes from the session, and there is no session in a jsdom realm. */
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { Customers } = await import('./Customers.js');

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`.
 * `shopOrdersRender.test.tsx` carries the same line and the same warning.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  authedRequest.mockReset();
});

/* ------------------------------------------------------------------ fixtures */

/** A row exactly as `serialiseCustomerListItem` composes it. */
const LATIFA = {
  id: 'MB-1a2b3c4d5e',
  name: 'Latifa A.',
  memberErased: false,
  memberPhone: '+96599124408',
  tier: 'gold',
  /** INTEGER FILS — #1. 32.500 KD, and never a float on the way here. */
  balanceFils: 32500,
  visits: 14,
  joinedAt: '2024-03-04T08:12:00.000Z',
};

/**
 * THE TOMBSTONE, AS THE SERVER ACTUALLY SENDS IT.
 *
 * `services/erasure.ts` sets `name` to `TOMBSTONE_NAME` and mints a `+990` phone
 * at rest — and `serialiseMemberContact` is what keeps those digits OFF the wire.
 * So the fixture carries `memberPhone: null`, which is the contract, and the
 * assertions below check that nothing resembling a number reaches the DOM either
 * way. The `+990` string appears nowhere in this file on purpose: a test that
 * fed it in would be testing a prefix match the client must not have.
 */
const ERASED = {
  id: 'MB-9f8e7d6c5b',
  name: 'Deleted account',
  memberErased: true,
  memberPhone: null,
  tier: null,
  balanceFils: 0,
  visits: 3,
  joinedAt: '2025-01-19T06:00:00.000Z',
};

const DETAIL = {
  ...LATIFA,
  salonId: 'SAL-AMARA',
  email: 'latifa.a@example.com',
  emailVerified: true,
  stamps: null,
};

const HISTORY = {
  items: [
    {
      id: 'TX-3233428',
      stream: 'transaction',
      at: '2026-09-24T15:12:00.000Z',
      who: 'Latifa A.',
      memberId: LATIFA.id,
      salonId: 'SAL-AMARA',
      what: 'topped up 25.000 via KNET',
      kind: 'topup',
      amountFils: 30000,
    },
    {
      id: 'LY-77a1b2c3',
      stream: 'loyalty',
      at: '2026-07-02T11:04:00.000Z',
      who: 'Latifa A.',
      memberId: LATIFA.id,
      salonId: 'SAL-AMARA',
      what: 'reached Gold tier',
      kind: 'tier_up',
      amountFils: null,
    },
  ],
  nextCursor: null,
};

function page(items: unknown[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

/** Routes a mocked request by path, so one test can answer three endpoints. */
function serve(handlers: Record<string, unknown | (() => unknown)>) {
  authedRequest.mockImplementation((_scope: string, path: string) => {
    for (const [fragment, answer] of Object.entries(handlers)) {
      if (path.includes(fragment)) {
        const value = typeof answer === 'function' ? (answer as () => unknown)() : answer;
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
    }
    return Promise.reject(new Error(`no fixture for ${path}`));
  });
}

function rig() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<Customers />, { wrapper: Wrapper });
}

/** Every path `authedRequest` was called with, in order. */
function paths(): string[] {
  return authedRequest.mock.calls.map((call) => call[1] as string);
}

/* ------------------------------------------------------------------- the book */

describe('the book renders a page', () => {
  it('draws a row per customer, with her wallet at the display boundary', async () => {
    serve({ '/customers': page([LATIFA, ERASED]) });
    rig();

    expect(await screen.findByText('Latifa A.')).toBeTruthy();
    expect(screen.getByText('Deleted account')).toBeTruthy();

    /*
     * THREE DECIMALS, FROM `formatFils` AND NOT FROM THIS SCREEN. 32500 fils is
     * "32.500" — non-negotiable #1's display boundary, and the assertion that the
     * integer was not divided somewhere on the way.
     */
    expect(screen.getByText(/32\.500/)).toBeTruthy();

    /* The count says what it can count. The endpoint serves no total. */
    expect(screen.getByRole('status').textContent).toBe('2 shown');
  });

  it('offers Show more only when the server sent a cursor', async () => {
    serve({ '/customers': page([LATIFA], 'opaque-cursor') });
    rig();

    await screen.findByText('Latifa A.');
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('does not offer Show more on the last page', async () => {
    serve({ '/customers': page([LATIFA], null) });
    rig();

    await screen.findByText('Latifa A.');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  /**
   * THE ORDER IS THE SERVER'S AND THE SCREEN DOES NOT RE-SORT IT.
   *
   * `joined_at DESC, id ASC` — `routes/customers.ts` chose it because
   * `streamCursor` pages instant-keyed streams only, so an alphabetical book would
   * need a second cursor grammar. A client that sorted its page by name would put
   * the rows in an order the NEXT page does not continue, which is worse than
   * either order: row 25 and row 26 would have no relationship at all.
   */
  it('renders the page in the order the server sent it', async () => {
    const older = { ...ERASED, name: 'Aisha B.', memberErased: false, memberPhone: '+96599000001' };
    serve({ '/customers': page([LATIFA, older]) });
    rig();

    await screen.findByText('Latifa A.');
    const names = screen.getAllByRole('row').slice(1).map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Latifa A.');
    expect(names[1]).toContain('Aisha B.');
  });
});

/* ---------------------------------------------------------------- the search */

describe('search is the server’s', () => {
  it('sends ?q= rather than filtering the page in hand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ '/customers': page([LATIFA]) });
    rig();

    await screen.findByText('Latifa A.');
    expect(paths()[0]).toBe('/salons/SAL-AMARA/customers');

    fireEvent.change(screen.getByLabelText(/Search this salon's customers/i), {
      target: { value: 'dana' },
    });

    /* Debounced by the screen — see `Customers.tsx`. Nothing leaves on a keystroke. */
    expect(paths()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(paths().length).toBeGreaterThan(1));
    expect(paths()[1]).toBe('/salons/SAL-AMARA/customers?q=dana');
  });

  /**
   * NO `?limit=`, EVER. `CUSTOMER_PAGE_SIZE` is a fixed 25 server-side and
   * `routes/customers.ts` declines to offer the knob, because a parameter that only
   * ever widens disclosure of a salon's customer book is not a parameter. A client
   * that sent one anyway would be asking for a refusal it could not read.
   */
  it('never asks for a page size', async () => {
    /* Two distinct pages, so the second is a continuation rather than a repeat. */
    let call = 0;
    serve({
      '/customers': () =>
        call++ === 0
          ? page([LATIFA], 'c1')
          : page([{ ...LATIFA, id: 'MB-page-two', name: 'Mariam K.' }], null),
    });
    rig();

    await screen.findByText('Latifa A.');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    await waitFor(() => expect(paths().length).toBeGreaterThan(1));
    for (const path of paths()) expect(path).not.toContain('limit=');
    expect(paths()[1]).toContain('cursor=c1');
  });
});

/* --------------------------------------------------------------- the empties */

describe('the two empties do not share copy', () => {
  it('a salon with no customers is told what fills the book', async () => {
    serve({ '/customers': page([]) });
    rig();

    expect(await screen.findByText('No customers yet')).toBeTruthy();
    /* No escape offered from a filter that is not there. */
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('a search that matched nothing echoes the query and offers the escape', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ '/customers': page([]) });
    rig();

    await screen.findByText('No customers yet');

    fireEvent.change(screen.getByLabelText(/Search this salon's customers/i), {
      target: { value: 'noura almu' },
    });
    await vi.advanceTimersByTimeAsync(400);

    expect(await screen.findByText('No customers match “noura almu”')).toBeTruthy();
    /* And it does NOT claim the salon has no customers. */
    expect(screen.queryByText('No customers yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });
});

/* ----------------------------------------------------------------- the states */

describe('the four states', () => {
  it('paints skeletons while pending, and announces no count it is not painting', () => {
    serve({ '/customers': () => new Promise(() => {}) });
    const { container } = rig();

    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    /*
     * THE PREMATURE ZERO, WHICH ON THIS SCREEN WOULD REACH BOTH THE VISIBLE COUNT
     * AND THE SR-ONLY CAPTION. `rows.length` is 0 before the first page lands, so
     * "0 shown" beside a column of skeletons is one `?? 0` away at all times. Both
     * halves are asserted because the caption is the half that went unnoticed on
     * both audit screens.
     */
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('table').textContent).not.toContain('0 customers are shown');
  });

  it('tells a server failure apart from a dead network', async () => {
    serve({
      '/customers': new ApiError('boom', { status: 500, code: 'internal' }),
    });
    rig();

    expect(await screen.findByText("Couldn't load the customer book")).toBeTruthy();
    expect(screen.getByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('renders the offline answer, not a server failure', async () => {
    serve({
      '/customers': new ApiError('no route to host', {
        status: 0,
        code: 'network',
        offline: true,
      }),
    });
    rig();

    expect(await screen.findByText('No connection')).toBeTruthy();
    expect(screen.getByText(/try again once you're back online/i)).toBeTruthy();
  });

  /**
   * A `team`-LESS SESSION IS A STATE, NOT A FAULT.
   *
   * The server's sentence is rendered verbatim because it is the only copy that
   * names the permission and who can grant it — and there is NO retry button,
   * because an identical request produces an identical refusal. A Retry on a 403
   * is the failure `sectionState.tsx` was written to stop: it reads as a bug in
   * the API and a merchant presses it until she calls someone.
   */
  it('renders the refusal verbatim and offers nothing to retry', async () => {
    serve({
      '/customers': new ApiError(
        'Your account cannot open Team & accounts. A manager can grant it.',
        { status: 403, code: 'forbidden' },
      ),
    });
    rig();

    expect(await screen.findByText("You don't have access to Team & accounts")).toBeTruthy();
    expect(
      screen.getByText('Your account cannot open Team & accounts. A manager can grant it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

/* ------------------------------------------------------------- the erased row */

describe('an erased customer is in the book and is not contactable', () => {
  it('keeps her row — a settled charge has to trace to something', async () => {
    serve({ '/customers': page([LATIFA, ERASED]) });
    rig();

    await screen.findByText('Latifa A.');
    /*
     * `customerDirectory.ts`: her transactions are records the retention schedule
     * keeps for seven years, so a directory that dropped her would make a settled
     * charge trace to a customer who cannot be opened.
     */
    expect(screen.getByText('Deleted account')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('draws no dialable affordance and no digits at all', async () => {
    serve({ '/customers': page([ERASED]) });
    rig();

    const row = (await screen.findByText('Deleted account')).closest('tr');
    expect(row).not.toBeNull();
    const cell = within(row as HTMLElement);

    expect(cell.getByText('Phone no longer held')).toBeTruthy();

    /*
     * TWO ASSERTIONS AND NOT ONE. Printing the tombstone as plain text passes "no
     * anchor" and fixes nothing a merchant with a handset cares about — she can
     * copy fabricated digits into a phone as easily as tap them. So: no link, and
     * no long run of digits anywhere in the row. The wallet is "0.000" and the
     * joined date is "Jan 2025", neither of which is a phone number.
     */
    expect((row as HTMLElement).querySelector('a')).toBeNull();
    expect((row as HTMLElement).querySelectorAll('[href]')).toHaveLength(0);
    expect(row?.textContent ?? '').not.toMatch(/\d{7,}/);
  });

  it('still dials a customer who has not been erased', async () => {
    serve({ '/customers': page([LATIFA]) });
    rig();

    const row = (await screen.findByText('Latifa A.')).closest('tr') as HTMLElement;
    const link = row.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('tel:+96599124408');
    /* E.164 against the bidi algorithm — the `+` must not travel to the far end. */
    expect(link?.getAttribute('dir')).toBe('ltr');
  });

  /**
   * THE MUTATION CHECK, WRITTEN INTO THE SUITE RATHER THAN RUN ONCE BY HAND.
   *
   * The failure this guards is silent: a payload where the join half-landed —
   * `memberErased: true` with a phone still attached — is exactly what the
   * fulfilment board shipped, and `=== null` alone would let it through. So the
   * arm that has no independent fixture in the contract gets one here, and a
   * client narrowed to a single condition fails this case while passing every
   * other test in this file.
   */
  it('refuses to dial an erased member even if a phone arrives with her', async () => {
    serve({ '/customers': page([{ ...ERASED, memberPhone: '+96599124408' }]) });
    rig();

    const row = (await screen.findByText('Deleted account')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Phone no longer held')).toBeTruthy();
    expect(row.querySelector('a')).toBeNull();
    expect(row.textContent ?? '').not.toContain('99124408');
  });

  /** And the other arm: a null phone on a live member is not a dialable link either. */
  it('refuses to dial a live member who has no phone on the wire', async () => {
    serve({ '/customers': page([{ ...LATIFA, memberPhone: null }]) });
    rig();

    const row = (await screen.findByText('Latifa A.')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Phone no longer held')).toBeTruthy();
    expect(row.querySelector('a')).toBeNull();
  });
});

/* -------------------------------------------------------------------- the card */

describe('one customer’s card', () => {
  async function openCard(overrides: Record<string, unknown> = {}) {
    serve({
      '/activity': HISTORY,
      // Longest-prefix first: the card's path is a prefix of the activity path.
      [`/customers/${LATIFA.id}`]: { ...DETAIL, ...overrides },
      '/customers': page([LATIFA]),
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
  }

  it('shows her profile and her history', async () => {
    await openCard();

    expect(await screen.findByText('Personal information')).toBeTruthy();
    expect(screen.getByText('Wallet')).toBeTruthy();
    expect(screen.getByText('Recent activity')).toBeTruthy();

    /*
     * THE SENTENCE IS THE SERVER'S. `activityFeed.ts § describeTransaction`
     * composes it because a top-up's `amount_fils` is what LANDED, bonus included
     * — a client that printed the column would tell a merchant her customer paid
     * five dinars she did not. This asserts the string arrived and was not
     * re-derived.
     */
    expect(await screen.findByText('topped up 25.000 via KNET')).toBeTruthy();
    expect(screen.getByText('reached Gold tier')).toBeTruthy();

    /* The raw signed integer is NOT drawn beside its own sentence. */
    expect(screen.queryByText(/30\.000/)).toBeNull();
  });

  it('reads the card and the history as two separate requests', async () => {
    await openCard();
    await screen.findByText('topped up 25.000 via KNET');

    expect(paths()).toContain(`/salons/SAL-AMARA/customers/${LATIFA.id}`);
    expect(paths()).toContain(`/salons/SAL-AMARA/customers/${LATIFA.id}/activity`);
  });

  /**
   * THE THREE UNSERVED PANELS ARE NAMED ON THE SCREEN.
   *
   * The requirement is that the absence is STATED, because a card silently missing
   * two of the design's six panels looks finished and wrong — and because the next
   * person to "fix" it is one client-side join away from handing a `team`-only
   * manager appointment data she is not granted.
   */
  it('says which panels the design draws that it does not', async () => {
    await openCard();

    const note = (await screen.findByText('Not on this card yet')).closest('div');
    expect(note).not.toBeNull();
    const panel = within(note as HTMLElement);
    expect(panel.getByText('Next booking')).toBeTruthy();
    expect(panel.getByText('Purchases')).toBeTruthy();
    expect(panel.getByText('Gift')).toBeTruthy();
    expect(panel.getByText('Reimburse')).toBeTruthy();
  });

  it('returns to the book', async () => {
    await openCard();
    await screen.findByText('Personal information');

    fireEvent.click(screen.getByRole('button', { name: /All customers/ }));
    expect(await screen.findByText('Latifa A.')).toBeTruthy();
    expect(screen.queryByText('Personal information')).toBeNull();
  });

  /**
   * `stamps === null` IS A TIERS SALON, NOT A ZERO. The column is nullable for
   * that reason and `customerDirectory.ts` refuses to default it — so nothing is
   * drawn, rather than "0 stamps" claimed about a salon that runs no stamp card.
   */
  it('draws no stamp line at a tiers salon', async () => {
    await openCard({ stamps: null });
    await screen.findByText('Wallet');
    expect(screen.queryByText(/stamps? collected/)).toBeNull();
  });

  it('draws the stamp count at a stamps salon, without a ladder it was not served', async () => {
    await openCard({ stamps: 6, tier: null });
    expect(await screen.findByText(/6 stamps collected/)).toBeTruthy();
    /* The target lives behind `perms.loyalty` and is not guessed. See the screen. */
    expect(screen.queryByText(/of 8/)).toBeNull();
  });

  /**
   * THE ERASED CARD, WHICH IS THE ROW'S GUARANTEE ONE LEVEL DOWN — and one field
   * further. `email` is nulled AT REST by erasure, so a null there means "erased"
   * on an erased member and "never gave us one" on a live one. One sentence for
   * both would report a customer who simply never typed an email as a deletion.
   */
  it('holds no contact details for an erased customer', async () => {
    serve({
      '/activity': { items: [], nextCursor: null },
      [`/customers/${ERASED.id}`]: {
        ...ERASED,
        salonId: 'SAL-AMARA',
        email: null,
        emailVerified: false,
        stamps: null,
      },
      '/customers': page([ERASED]),
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    const info = (await screen.findByText('Personal information')).closest('div') as HTMLElement;
    expect(within(info).getByText('Phone no longer held')).toBeTruthy();
    expect(within(info).getByText('No longer held')).toBeTruthy();
    expect(info.querySelector('a')).toBeNull();
  });

  it('distinguishes a live customer who never gave an email', async () => {
    await openCard({ email: null });
    const info = (await screen.findByText('Personal information')).closest('div') as HTMLElement;
    expect(within(info).getByText('None on file')).toBeTruthy();
    expect(within(info).queryByText('No longer held')).toBeNull();
  });

  /* ---- the card's own states ---- */

  it('skeletons the card while it loads, painting no balance', async () => {
    serve({
      '/activity': () => new Promise(() => {}),
      [`/customers/${LATIFA.id}`]: () => new Promise(() => {}),
      '/customers': page([LATIFA]),
    });
    const { container } = rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    await waitFor(() => expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0));
    /* interaction-spec.md §4: money fields skeleton as a bar, never `0.000`. */
    expect(container.textContent).not.toContain('0.000');
  });

  /**
   * A 404 IS A SENTENCE, NOT A SERVER FAILURE.
   *
   * `loadCustomer` answers `404 unknown_member` for an id that is not in this
   * salon — byte-identical to one that exists nowhere, so the endpoint cannot be
   * used as an oracle. Routed through `SectionError` it would read "Something went
   * wrong on our side", which is false twice over: nothing went wrong, and
   * retrying will answer the same thing forever.
   */
  it('names an id that is not in this salon, and offers no retry', async () => {
    serve({
      '/activity': new ApiError('No such member.', { status: 404, code: 'unknown_member' }),
      [`/customers/${LATIFA.id}`]: new ApiError('No such member.', {
        status: 404,
        code: 'unknown_member',
      }),
      '/customers': page([LATIFA]),
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText("That customer isn't in this salon's book")).toBeTruthy();
    expect(screen.queryByText(/Something went wrong on our side/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  /**
   * THE HISTORY FAILING MUST NOT BLANK THE PROFILE. Two reads, two states — the
   * split `routes/customers.ts` made because her activity grows and her row does
   * not, carried to the client. A merchant who opened the card to check a balance
   * still gets the balance.
   */
  it('keeps the profile when only the history fails', async () => {
    serve({
      '/activity': new ApiError('boom', { status: 500, code: 'internal' }),
      [`/customers/${LATIFA.id}`]: DETAIL,
      '/customers': page([LATIFA]),
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText("Couldn't load her history")).toBeTruthy();
    expect(screen.getByText('Personal information')).toBeTruthy();
    expect(screen.getByText(/32\.500/)).toBeTruthy();
  });

  /** A customer with nothing settled yet is a third empty, about her and not the book. */
  it('names what fills an empty history', async () => {
    serve({
      '/activity': { items: [], nextCursor: null },
      [`/customers/${LATIFA.id}`]: DETAIL,
      '/customers': page([LATIFA]),
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText('Nothing yet')).toBeTruthy();
    expect(screen.queryByText('No customers yet')).toBeNull();
  });
});
