// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `noShowCount` APPEARS ON ONE CARD ABOUT ONE PERSON, AND NOWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 * The client's request that produced the deposit queue is about customers who
 * repeatedly lock a slot and do not come. `api/src/services/customerDirectory.ts
 * § countMemberNoShows` refuses to turn that into a score, a risk band, a flag, a
 * threshold or a worst-first sort, and says why: every one of those ships a
 * server-made claim about a person, and a claim nobody can appeal — there is no
 * screen on which a customer can see it, dispute it, or learn it exists.
 *
 * LANE A'S SENTENCE, WHICH TRUNK ENDORSED AND THIS FILE ENFORCES:
 *
 *     a column of counts down a page of names is a ranking whether or not
 *     anything sorts by it.
 *
 * So the count is served on the CUSTOMER DETAIL and never on a list, and the
 * client half of that is a rule about where it may be DRAWN. That rule is one
 * `<td>` away from being broken by somebody being helpful, and it would look like
 * an improvement in a diff — which is why it is a test and not a comment.
 *
 * ===========================================================================
 * THREE GUARANTEES, AND THE THIRD IS THE ONE A SOURCE SCAN CANNOT GIVE
 * ===========================================================================
 *   1. IT RENDERS ON THE CARD, beside `visits`, in the same line and the same
 *      register. Two numbers about one person, and the merchant's own judgement.
 *   2. IT RENDERS AT ZERO. This is load-bearing: hiding it at 0 would make its
 *      PRESENCE the flag — every card that showed the line would be a card about
 *      someone with a record, which is a worse boolean than the one the field is
 *      forbidden to become, because nothing would be labelled.
 *   3. IT IS ABSENT FROM EVERY LIST — the customer book, the deposit queue, the
 *      appointment board — asserted against the rendered DOM and against the
 *      source, because the two fail differently. A source scan misses a count
 *      rendered through a variable; a render test misses a field wired up behind
 *      a flag nobody set in the fixture.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../testing/stripComments.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { Customers } = await import('./Customers.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  authedRequest.mockReset();
});

/* ---------------------------------------------------------------- fixtures */

/**
 * THE BOOK'S ROW AND THE CARD, AS THE TWO SERIALISERS ACTUALLY COMPOSE THEM.
 *
 * `serialiseCustomerListItem` has eight fields and `noShowCount` is not among
 * them — so `LIST` carries no such key, deliberately. A fixture that added one
 * would let the book render a figure the wire has never sent, and the absence
 * assertions below would pass for the wrong reason.
 */
const LIST = {
  id: 'MB-1a2b3c4d5e',
  name: 'Latifa A.',
  memberErased: false,
  memberPhone: '+96599124408',
  tier: 'gold',
  balanceFils: 32500,
  visits: 14,
  joinedAt: '2024-03-04T08:12:00.000Z',
};

const CARD = {
  ...LIST,
  salonId: 'SAL-AMARA',
  email: 'latifa.a@example.com',
  emailVerified: true,
  stamps: null,
  noShowCount: 3,
};

function serve(handlers: Record<string, unknown>) {
  authedRequest.mockImplementation((_scope: string, path: string) => {
    for (const [fragment, answer] of Object.entries(handlers)) {
      if (path.includes(fragment)) return Promise.resolve(answer);
    }
    return Promise.reject(new Error(`no fixture for ${path}`));
  });
}

function rig() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<Customers />, { wrapper: Wrapper });
}

async function openCard(card: Record<string, unknown> = CARD) {
  serve({
    '/activity': { items: [], nextCursor: null },
    [`/customers/${LIST.id}`]: card,
    '/customers': { items: [LIST], nextCursor: null },
  });
  const rendered = rig();
  fireEvent.click(await screen.findByRole('button', { name: 'View' }));
  await screen.findByText('Personal information');
  return rendered;
}

/* ============================================== it is on the card ========== */

describe('her no-show count sits beside her visits, on her own card', () => {
  it('renders both numbers in one line, in one register', async () => {
    const { container } = await openCard();

    const since = container.querySelector('.cust-card__since') as HTMLElement;
    expect(since).toBeTruthy();
    expect(since.textContent).toContain('14 visits');
    expect(since.textContent).toContain('3 no-shows');
    // One line, not a panel of its own and not a badge somewhere else.
    expect(container.querySelectorAll('.cust-card__since')).toHaveLength(1);
  });

  /**
   * NO TONE, NO GLYPH, NO PILL, NO CLASS OF ITS OWN. The count is text in the
   * same element as `visits`, which is the design: a number a merchant can weigh
   * against another number, not a verdict she is handed. A `Pill`, an icon or a
   * `data-tone` here would make the judgement for her.
   */
  it('gives the number no tone, no icon and no element of its own', async () => {
    const { container } = await openCard();

    const since = container.querySelector('.cust-card__since') as HTMLElement;
    expect(since.querySelector('svg')).toBeNull();
    expect(since.querySelector('.avo-pill')).toBeNull();
    expect(since.querySelector('[data-tone]')).toBeNull();
    // The two counts are siblings in the same text run — no wrapper singles one out.
    expect(since.querySelectorAll('*')).toHaveLength(0);
  });

  /**
   * ===========================================================================
   * IT RENDERS AT ZERO, AND THAT IS THE LOAD-BEARING HALF
   * ===========================================================================
   * Hiding the line at 0 would make its PRESENCE the flag: every card that showed
   * it would be a card about someone with a record. That is exactly the boolean
   * `countMemberNoShows` refuses to become, and a worse version of it, because
   * nothing would be labelled and nobody would know the rule existed.
   */
  it('renders “0 no-shows” rather than hiding the line', async () => {
    const { container } = await openCard({ ...CARD, noShowCount: 0 });
    const since = container.querySelector('.cust-card__since') as HTMLElement;
    expect(since.textContent).toContain('0 no-shows');
  });

  it('says “1 no-show”, not “1 no-shows”', async () => {
    const { container } = await openCard({ ...CARD, noShowCount: 1 });
    expect((container.querySelector('.cust-card__since') as HTMLElement).textContent).toContain(
      '1 no-show',
    );
    expect(
      (container.querySelector('.cust-card__since') as HTMLElement).textContent,
    ).not.toContain('1 no-shows');
  });

  /**
   * A MISSING KEY IS A FAILED READ, NOT A ZERO. The server refuses to default it
   * — "a `0` default would make 'she has never missed an appointment' and 'this
   * caller forgot to ask' the same number, on a field about a named woman's
   * conduct" — and `parseCustomerDetail` is the client half of that. A server that
   * stopped sending it must not silently exonerate everybody.
   */
  it('fails the card read rather than defaulting the count to zero', async () => {
    const { noShowCount: _dropped, ...withoutIt } = CARD;
    serve({
      '/activity': { items: [], nextCursor: null },
      [`/customers/${LIST.id}`]: withoutIt,
      '/customers': { items: [LIST], nextCursor: null },
    });
    rig();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText("Couldn't load this customer")).toBeTruthy();
    expect(screen.queryByText(/no-show/)).toBeNull();
  });
});

/* ============================================ it is in no list ============= */

describe('it appears in no list, anywhere', () => {
  it('is absent from every row of the customer book', async () => {
    serve({ '/customers': { items: [LIST, { ...LIST, id: 'MB-2', name: 'Dana K.' }], nextCursor: null } });
    const { container } = rig();
    await screen.findByText('Latifa A.');

    const table = container.querySelector('table') as HTMLElement;
    expect(table.textContent?.toLowerCase()).not.toContain('no-show');
    // …and no column was added for it either.
    const heads = [...table.querySelectorAll('th')].map((th) => th.textContent?.toLowerCase());
    for (const head of heads) expect(head).not.toContain('no-show');
  });

  /**
   * THE BOOK'S OWN SHAPE IS WHAT MAKES THIS STRUCTURAL. `parseCustomerListItem`
   * has no such field, so a row COULD not render one without a second request per
   * customer — the absence above is a property of the parser, not of the fixture.
   */
  it('is not a field a list row could render even if someone tried', () => {
    const src = stripComments(
      readFileSync(join(__dirname, '..', 'api', 'customers.ts'), 'utf8'),
    );
    const listParser = src.slice(
      src.indexOf('export function parseCustomerListItem'),
      src.indexOf('export function parseCustomerBook'),
    );
    expect(listParser.length).toBeGreaterThan(100);
    expect(listParser).not.toContain('noShowCount');

    // It IS read by the card's parser — a zero result above would otherwise be a
    // claim about the slice rather than about the field.
    const cardParser = src.slice(src.indexOf('export function parseCustomerDetail'));
    expect(cardParser).toContain('noShowCount');
  });

  /**
   * NO OTHER SCREEN DRAWS IT. `Customers.tsx` is the one file allowed to mention
   * it; every other route is scanned, so a count added to the deposit queue, the
   * appointment board or the week grid fails HERE rather than shipping.
   *
   * SOURCE-SCANNED AND NOT RENDERED, deliberately: rendering every screen to
   * prove a negative needs a fixture per screen, and a fixture that omitted the
   * field would pass whatever the component did with it. The scan asks the
   * question of the code instead, which is where the answer honestly lives.
   */
  it('is mentioned by no route but the customer card', () => {
    const routes = join(__dirname);
    const offenders: string[] = [];
    for (const dir of ['.', 'console', 'marketing']) {
      const at = join(routes, dir === '.' ? '' : dir);
      for (const name of readdirSync(at)) {
        if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue;
        if (dir === '.' && name === 'Customers.tsx') continue;
        if (stripComments(readFileSync(join(at, name), 'utf8')).includes('noShowCount')) {
          offenders.push(`${dir}/${name}`);
        }
      }
    }
    expect(offenders, 'a screen other than the customer card renders her no-show count').toEqual(
      [],
    );
  });

  /**
   * A ZERO RESULT ABOVE IS A CLAIM ABOUT THE SCAN. The known positive proves the
   * reader, the directory walk and the comment-stripping all work — without it,
   * a typo'd path would report a clean sweep for ever.
   */
  it('proves its own scan against the one file that does mention it', () => {
    const src = stripComments(readFileSync(join(__dirname, 'Customers.tsx'), 'utf8'));
    expect(src).toContain('noShowCount');
  });

  /**
   * AND NOTHING SORTS, FILTERS OR THRESHOLDS ON IT. The rule is not only "it is
   * not drawn in a list" but "it does not decide anything" — a comparison against
   * it anywhere in this tree is a threshold, which is the moment a number stops
   * being evidence and becomes a label.
   */
  it('is compared against nothing, anywhere in the dashboard', () => {
    const src = stripComments(readFileSync(join(__dirname, 'Customers.tsx'), 'utf8'));
    // The only expression it appears in is the singular/plural ternary and the
    // value itself — no >, <, >=, <=, sort or filter.
    expect(src).not.toMatch(/noShowCount\s*[<>]/);
    expect(src).not.toMatch(/noShowCount\s*[<>]=/);
    expect(src).not.toMatch(/sort\s*\([^)]*noShowCount/);
    expect(src).not.toMatch(/filter\s*\([^)]*noShowCount/);
    // `=== 1` is the plural rule and is the one comparison allowed.
    expect(src).toMatch(/noShowCount === 1/);
  });
});
