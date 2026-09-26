// @vitest-environment jsdom

/**
 * THE TEAM ROSTER — somebody else's permissions, displayed and edited.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Five casts, none parsed. `api/client.ts` ends in `await response.json() as T`,
 * so `authedRequest<Paginated<StaffUser>>` asserted a shape nothing proved, and
 * `routes/Accounts.tsx` read it two levels deep on every render.
 *
 * WHAT THIS IS NOT. It is not an authority bypass. The gates on this dashboard's
 * own UI come from `session.perms` through `auth/session.ts § isStoredSession`,
 * which IS validated, and every route here is `perms.team` server-side
 * regardless. Non-negotiable #7 is untouched either way.
 *
 * THE RULE WORTH MORE THAN THE REST
 * ---------------------------------
 * "HESSA HOLDS NOTHING" AND "WE COULD NOT READ WHAT HESSA HOLDS" ARE DIFFERENT
 * SENTENCES, AND ONLY ONE IS SAFE TO ACT ON. A defaulted `perms` renders nine
 * chips all off: a complete, confident, editable picture of an authority this
 * client never received. Worse than the crash, because `Accounts.tsx:212` reads
 * that picture as `before` — the left side of a permission diff — so a manager
 * toggles one chip believing the other eight, and `changedPerms` computes the
 * write from a state that was never true.
 *
 * So the negative assertions are the point: a malformed row must produce the
 * failed-read state, must NOT produce a card, and must NOT produce the empty
 * state either — "no accounts" is its own confident claim about a salon.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Component } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** A manager holding `perms.team` — the screen's own gate is the server's 403. */
const SESSION = {
  staffId: 'ST-001',
  salonId: 'SAL-AMARA',
  perms: { team: true, dashboard: true },
};
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => SESSION,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const { parseStaffPage, parseStaffUser, staffKeys, useUpdateStaff } = await import('./staff.js');
const { Accounts } = await import('../routes/Accounts.js');
type StaffUser = import('@avo/types').StaffUser;
type Paginated<T> = import('./salon.js').Paginated<T>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------- the bodies -- */

/** `serialiseStaff`'s eleven keys, field for field. A plain object on purpose. */
const PERMS_BODY: Record<string, unknown> = {
  dashboard: true,
  appointments: true,
  shop: false,
  loyalty: false,
  team: false,
  scanner: true,
  charges: false,
  void: false,
  marketing: false,
};

/** `db/seed.ts § ST-002` — Hessa, front desk. `appointments: true, team: false`. */
const HESSA_BODY: Record<string, unknown> = {
  id: 'ST-002',
  salonId: 'SAL-AMARA',
  name: 'Hessa Al-Mutairi',
  handle: 'hessa',
  role: 'frontdesk',
  branchAccess: ['BR-SAL'],
  pinSet: true,
  passwordSet: true,
  active: true,
  deactivatedAt: null,
  perms: PERMS_BODY,
};

const SALON_BODY: Record<string, unknown> = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  stampTarget: null,
  stampReward: null,
  stampRewardAr: null,
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' }],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
};

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

const page = (...rows: unknown[]) => ({ items: rows, nextCursor: null });

/* ========================================================================== */
/**
 * TABLE-DRIVEN OFF THE BODIES, so a twelfth field on `serialiseStaff` or a tenth
 * permission is covered the day these fixtures learn about it.
 */
describe('a roster row missing any required key is a failed read', () => {
  for (const key of Object.keys(HESSA_BODY)) {
    it(`refuses a staff row with no ${key}`, () => {
      expect(() => parseStaffUser(without(HESSA_BODY, key))).toThrow();
    });
  }

  /**
   * EVERY PERMISSION, INDIVIDUALLY. Nine booleans, and a missing one is the case
   * that matters most: it is the difference between a grant that is off and a
   * grant nobody read. Looping the key list means a tenth permission added to
   * `StaffPermsSchema` is covered without anyone remembering to add a case.
   */
  for (const key of Object.keys(PERMS_BODY)) {
    it(`refuses a staff row whose perms has no ${key}`, () => {
      expect(() =>
        parseStaffUser({ ...HESSA_BODY, perms: without(PERMS_BODY, key) }),
      ).toThrow();
    });
  }

  it('refuses a page whose items is not an array, naming the endpoint', () => {
    expect(() => parseStaffPage({ nextCursor: null })).toThrow(/GET \/staff\.items/);
  });

  it('names the row index when one row in a populated page is bad', () => {
    expect(() =>
      parseStaffPage(page(HESSA_BODY, without(HESSA_BODY, 'perms'))),
    ).toThrow(/items\[1\]/);
  });

  /**
   * A BAD ROW FAILS THE WHOLE PAGE RATHER THAN BEING DROPPED, and this pins that
   * choice. Skipping it would remove a colleague from the Team list silently —
   * and the list is what `soleTeamAdminId` is counted from, so a dropped row
   * could let the screen offer to revoke the last `perms.team` it can see.
   */
  it('refuses the page rather than serving the rows it could read', () => {
    expect(() => parseStaffPage(page(HESSA_BODY, { id: 'ST-003' }))).toThrow();
  });

  it('accepts the roster the server actually sends', () => {
    const parsed = parseStaffPage(page(HESSA_BODY));
    expect(parsed.items[0]?.perms.team).toBe(false);
    expect(parsed.items[0]?.branchAccess).toEqual(['BR-SAL']);
  });

  it('accepts branchAccess: "all", which is a string and not a list', () => {
    expect(parseStaffUser({ ...HESSA_BODY, branchAccess: 'all' }).branchAccess).toBe('all');
  });
});

/* ========================================================================== */

/**
 * A boundary of our own, standing in for the router's CatchBoundary. Without it a
 * regression that makes `Accounts.tsx:97` throw on `a.perms.team` fails here as a
 * TIMEOUT — "none of the three answers appeared" — which is a true statement
 * about the wrong thing. With it, the red names the crash.
 */
class Boundary extends Component<{ children: ReactNode }, { caught: string | null }> {
  override state = { caught: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { caught: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.caught === null ? this.props.children : <p>boundary: {this.state.caught}</p>;
  }
}

const caught = () => screen.queryByText(/^boundary:/);

function mount(rosterBody: unknown) {
  authedRequest.mockImplementation((_scope: string, path: string) =>
    Promise.resolve(String(path).startsWith('/staff') ? rosterBody : SALON_BODY),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <Boundary>
      <QueryClientProvider client={client}>
        <Accounts />
      </QueryClientProvider>
    </Boundary>,
  );
}

const FAILED = "Couldn't load the team accounts";
const EMPTY_TITLE = 'No team accounts';

/** Settle on whichever of the three answers the screen reached. */
const settled = () =>
  waitFor(() =>
    expect(
      screen.queryByText(FAILED) ??
        screen.queryByText(EMPTY_TITLE) ??
        screen.queryByText('Hessa Al-Mutairi') ??
        caught(),
    ).not.toBeNull(),
  );

describe('a row whose permissions we could not read is not a person with none', () => {
  /**
   * THE SPEC THIS FILE IS FOR. `perms` missing used to throw at
   * `Accounts.tsx:97` — or, under a `?? {}`, render nine chips all off, which is
   * the worse of the two because it is actionable.
   */
  it('renders the failed read, and not a card of nine unset permissions', async () => {
    mount(page(without(HESSA_BODY, 'perms')));
    await settled();
    // The section did not fall over: `Accounts.tsx:97` reads `a.perms.team` on
    // every row, and an unparsed roster is where that throw came from.
    expect(caught()).toBeNull();
    expect(screen.getByText(FAILED)).toBeTruthy();
    // Not her card. A name here would mean a row was drawn from a body we could
    // not read, and every chip beside it would be a claim about her authority.
    expect(screen.queryByText('Hessa Al-Mutairi')).toBeNull();
    expect(screen.queryByText('Team & accounts')).toBeNull();
    expect(screen.queryByText('Scan & charge')).toBeNull();
    // And not the empty state: "this salon has no accounts" is its own confident
    // claim, and flattening a failed read into it is the same class of lie.
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
  });

  it('renders the failed read for a row missing one single permission', async () => {
    mount(page({ ...HESSA_BODY, perms: without(PERMS_BODY, 'void') }));
    await settled();
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(screen.queryByText('Hessa Al-Mutairi')).toBeNull();
  });

  /** Offers the retry, because an unreadable body is "we failed", not "you can't". */
  it('offers a retry on the failed read', async () => {
    mount(page(without(HESSA_BODY, 'perms')));
    await settled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the well-formed cases still render exactly what they rendered', () => {
  /** The copy is pinned so a regression has to move a sentence, not just a state. */
  it('draws the account, her role and her permission chips', async () => {
    mount(page(HESSA_BODY));
    await settled();
    expect(screen.getByText('Hessa Al-Mutairi')).toBeTruthy();
    expect(screen.getByText('Team & accounts')).toBeTruthy();
    expect(screen.getByText('Scan & charge')).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
  });

  /**
   * THE GENUINE EMPTY SURVIVES. A salon with no team accounts is a real state
   * with its own words, and it must not be swallowed by the parse the way the
   * failed read must not be dressed up as it.
   */
  it('a genuinely empty roster still says its own sentence, verbatim', async () => {
    mount(page());
    await settled();
    expect(screen.getByText(EMPTY_TITLE)).toBeTruthy();
    expect(
      screen.getByText(
        'Add a teammate to create their sign-in, then set exactly what they are allowed to do. They receive a link to set their own password — you never type one for them.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});

/* ========================================================================== */
describe('a write whose answer we cannot read does not patch the roster', () => {
  /**
   * `useUpdateStaff` writes the response INTO the list cache, and the file says
   * why: revoking `charges` also revokes `void` server-side, and "the chips
   * settle on what the server stored rather than on what was clicked". A cast
   * there put an unverified row into the roster every other reader shares.
   */
  it('leaves the cached row standing when the PATCH answer is not a staff user', async () => {
    const good = parseStaffUser(HESSA_BODY);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<Paginated<StaffUser>>(staffKeys.list('SAL-AMARA'), {
      items: [good],
      nextCursor: null,
    });
    authedRequest.mockResolvedValue(without(HESSA_BODY, 'perms'));

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => useUpdateStaff(), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({ staffId: 'ST-002', patch: { perms: { void: true } } })
        .catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = client.getQueryData<Paginated<StaffUser>>(staffKeys.list('SAL-AMARA'));
    expect(cached?.items[0]).toEqual(good);
  });
});
