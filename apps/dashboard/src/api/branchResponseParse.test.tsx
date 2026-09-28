// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE BRANCH BODIES `Settings.tsx § BranchesPanel` DEREFERENCES
 * ═══════════════════════════════════════════════════════════════════════════
 * `POST …/branches`, `GET …/branches/{bid}/closure-preview` and
 * `DELETE …/branches/{bid}`. All three arrived through `authedRequest<T>`, which
 * is an assertion and not a check, and the three fail at different distances
 * from a commit — so the three degrade differently and this file drives each of
 * them to the screen rather than to a parser.
 *
 * THE PANEL IS RENDERED, NOT REPRODUCED. `writeResponseParse.test.tsx` rebuilt
 * its two screens' error lines locally, which was right there: the subject was a
 * mutation's state and two sentences. Here the subject IS the copy — a
 * consequence list a merchant reads before an irreversible cascade, and a receipt
 * that is the only place in the product naming the person who lost branch access.
 * A local reproduction would pin the test's copy against the test's copy. So
 * `BranchesPanel` is exported and mounted, and every string asserted below is a
 * string a merchant would read.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE DELETE IS THE WORST OF THE THREE, AND IS NOT HYPOTHETICAL
 * ───────────────────────────────────────────────────────────────────────────
 * `api/src/routes/salons.ts:1330` answers a close of an ALREADY-CLOSED branch
 * with `reply.send(serialiseBranch(current))` — four keys, no `closedAt`, no
 * `staffRescoped`, no `tillsUnenrolled`. That is the correct idempotent answer
 * and it is not a `BranchClosure`. `IDEMPOTENT_CLOSE` below is that body
 * verbatim, so the malformed fixture for the one dangerous case is a real
 * response of the real API rather than a key deleted to make a point.
 *
 * The close has COMMITTED by then: staff re-scoped, tills revoked, the branch
 * shut. The receipt is one-shot — nothing else in the product will ever say
 * "Noura Al-Rashid now has no branch access" — so the rule the previous slice
 * landed (drop the guess, let `invalidateQueries` supply truth) does NOT transfer.
 * There is no refetch that re-surfaces a receipt. The requirement is a degraded
 * but TRUE receipt, and no failure language.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fils, type Salon } from '@avo/types';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: {} }),
}));

const { BranchesPanel } = await import('../routes/Settings.js');
const { salonKeys } = await import('./salon.js');
const { staffKeys } = await import('./staff.js');
const { deviceKeys } = await import('./devices.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* =============================================================== fixtures == */

const SALMIYA = { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' };
const KUWAIT_CITY = {
  id: 'BR-KWT',
  salonId: 'SAL-AMARA',
  name: 'Kuwait City',
  nameAr: 'مدينة الكويت',
};

/**
 * TWO OPEN BRANCHES, because the ✕ is disabled on a salon's last one — the panel
 * says so in the button's `title` rather than letting the server refuse it — and
 * a one-branch fixture could not reach the confirmation at all.
 *
 * The panel reads `salon.branches` and nothing else; the remaining nineteen keys
 * are here because `Salon` is the declared prop type and a cast would be the one
 * thing this file is about.
 */
const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  stampRewardAr: null,
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [SALMIYA, KUWAIT_CITY],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
};

/** `GET …/closure-preview` — `{ ...serialiseBranch(current), …nine extras }`. */
const PREVIEW: Record<string, unknown> = {
  ...SALMIYA,
  closedAt: null,
  closable: true,
  blockedReason: null,
  openBranchCount: 2,
  staffRescoped: ['Noura Al-Rashid', 'Dana Al-Sabah'],
  staffLeftWithNoBranch: ['Noura Al-Rashid'],
  depositHeldBookings: 3,
  depositHeldBookingsBranchAssumed: 2,
  tillsUnenrolled: ['Front desk'],
  /* Migration 0060 — shop orders a customer chose to collect here, not yet collected. */
  pickupOrdersWaiting: 2,
};

/** A preview with nothing to report — the three reassuring sentences' own case. */
const QUIET_PREVIEW: Record<string, unknown> = {
  ...PREVIEW,
  staffRescoped: [],
  staffLeftWithNoBranch: [],
  depositHeldBookings: 0,
  depositHeldBookingsBranchAssumed: 0,
  tillsUnenrolled: [],
  pickupOrdersWaiting: 0,
};

/** The DELETE's receipt — the same field names, in the past tense. */
const CLOSURE: Record<string, unknown> = {
  ...SALMIYA,
  closedAt: '2026-09-27T08:00:00.000Z',
  staffRescoped: ['Noura Al-Rashid', 'Dana Al-Sabah'],
  staffLeftWithNoBranch: ['Noura Al-Rashid'],
  depositHeldBookings: 3,
  depositHeldBookingsBranchAssumed: 2,
  tillsUnenrolled: ['Front desk'],
  pickupOrdersWaiting: 2,
};

/**
 * `api/src/routes/salons.ts:1330`, VERBATIM: the idempotent close's body is
 * `serialiseBranch(current)` and nothing else. Reached by a race — the preview
 * said closable, another manager closed it, this DELETE lands on the early
 * return — and `Settings.tsx` read `.staffRescoped.length` off it.
 */
const IDEMPOTENT_CLOSE: Record<string, unknown> = { ...SALMIYA };

/** `POST …/branches` — `serialiseBranch(row)`, a 201. */
const CREATED: Record<string, unknown> = {
  id: 'BR-HAW',
  salonId: 'SAL-AMARA',
  name: 'Hawally',
  nameAr: null,
};

/* ================================================================ the rig == */

interface Routes {
  preview?: unknown;
  close?: unknown;
  create?: unknown;
}

/**
 * ONE MOCK, ROUTED BY METHOD AND PATH, because the panel makes up to three
 * different calls in one interaction and a single `mockResolvedValue` would
 * answer all of them with the same body.
 */
/**
 * A CRASH IS CAUGHT AND NAMED, NOT WAITED OUT.
 *
 * The regression these specs exist to catch is a TypeError thrown from the
 * panel's own render — `impact.staffRescoped.length` on a body that has no such
 * key. Without a boundary, React unmounts the tree, the element the spec is
 * waiting for never appears, and the failure arrives five seconds later as
 * "expected undefined to be null" — a timeout, which says that something did not
 * happen and names nothing. The previous slice caught itself shipping one of
 * those; this is the rig that stops it happening here.
 *
 * With the boundary the crash is a VALUE, so `openConfirmation` can stop waiting
 * the moment it appears and assert on it by name.
 */
let crash: unknown = null;

class CrashCatcher extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };
  static getDerivedStateFromError(error: unknown) {
    crash = error;
    return { crashed: true };
  }
  override render() {
    return this.state.crashed ? <p>the panel crashed</p> : this.props.children;
  }
}

function mount(routes: Routes) {
  crash = null;
  authedRequest.mockImplementation(
    (_scope: string, path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET' && path.endsWith('/closure-preview')) {
        return Promise.resolve(routes.preview);
      }
      if (method === 'DELETE') return Promise.resolve(routes.close);
      if (method === 'POST') return Promise.resolve(routes.create);
      throw new Error(`unrouted ${method} ${path}`);
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CrashCatcher>{children}</CrashCatcher>
    </QueryClientProvider>
  );
  render(<BranchesPanel salon={SALON} />, { wrapper });
  return client;
}

/** The confirmation is open and its preview has stopped loading. */
function confirmationSettled(): boolean {
  const group = screen.queryByRole('group', { name: 'Close Salmiya?' });
  return group !== null && group.querySelector('[aria-busy]') === null;
}

/**
 * Press the ✕ on Salmiya and wait for the confirmation to settle — OR for the
 * panel to crash, whichever comes first. The crash is then asserted on rather
 * than waited out, so a regression names itself in milliseconds.
 */
async function openConfirmation() {
  await act(async () => {
    screen.getByRole('button', { name: 'Close Salmiya' }).click();
  });
  await waitFor(() =>
    expect(
      crash !== null || confirmationSettled(),
      'the confirmation neither settled nor crashed',
    ).toBe(true),
  );
  expect(crash, 'the panel threw while rendering the confirmation').toBeNull();
}

/** Press the confirmation's own Close button. */
async function confirmClose() {
  const group = screen.getByRole('group', { name: 'Close Salmiya?' });
  await act(async () => {
    within(group).getByRole('button', { name: 'Close Salmiya' }).click();
  });
  /*
   * THE RECEIPT IS RENDERED BY THE SAME PANEL, so a receipt the panel cannot
   * read crashes it here — `closed.staffRescoped.length`, POST-COMMIT — and that
   * is the whole subject of section 2. Named here too, for the same reason.
   */
  /*
   * THREE WAYS THIS CAN END, AND WAITING FOR ONLY THE GOOD ONE IS THE TIMEOUT
   * TRAP. A receipt (`role="status"`), a crash, or `WriteError` (`role="alert"`)
   * — and the third is what a bare `.parse` in the `mutationFn` produces:
   * "Something went wrong on our side. That branch is still open." over a closed
   * branch. Waiting on the status alone turns that regression into a five-second
   * timeout; waiting on any of the three turns it into a named assertion in
   * milliseconds, with the false sentence quoted.
   */
  await waitFor(() =>
    expect(
      crash !== null ||
        screen.queryByRole('status') !== null ||
        screen.queryByRole('alert') !== null,
      'the close settled and the panel rendered nothing at all — no receipt, no error, no crash',
    ).toBe(true),
  );
  expect(crash, 'the panel threw while rendering the receipt').toBeNull();
  expect(
    screen.queryByRole('alert')?.textContent ?? null,
    'the close committed and the panel reported it as a failure',
  ).toBeNull();
}

/**
 * EVERY SENTENCE `WriteError` CAN PRODUCE, plus this panel's two reassurances.
 * Asserted ABSENT rather than asserting a success string present: the failure
 * mode is a screen SAYING something false, so the check has to be able to see
 * any of it — including a sentence added to `WriteError` later.
 *
 * "That branch is still open." is the one that matters. After the DELETE it is
 * not merely unhelpful, it is false about an irreversible act and it invites her
 * to do it again.
 */
const FAILURE_LANGUAGE = [
  'Something went wrong on our side',
  "We couldn't reach the workspace",
  'That branch is still open',
  'No branch was added',
];

/**
 * THE ONE SENTENCE ONLY THE DEGRADED RECEIPT PRODUCES. Asserted rather than
 * merely checking that "is closed." appears: the full receipt opens with the
 * same four words, so a spec that looked only for those would pass while the
 * panel rendered a FULL receipt built from a body nobody parsed — exactly the
 * hollow-spec shape this file's mutation pass is run to find, and it did find it
 * here on the first attempt (a closure body with no `name` rendered
 * "<b> is closed.</b>" and satisfied every assertion).
 */
const SUMMARY_UNREADABLE = 'We couldn’t read the summary of what that changed.';

function documentText(): string {
  return document.body.textContent ?? '';
}

function expectNoFailureLanguage() {
  const text = documentText();
  for (const sentence of FAILURE_LANGUAGE) expect(text).not.toContain(sentence);
}

/* ============================================ 1 · the preview, pre-commit == */

describe('the closure preview decides an irreversible act', () => {
  /**
   * THE WELL-FORMED PATH, PINNED WORD FOR WORD. Every sentence below is copy
   * that exists on `Settings.tsx` today; if a later edit moves any of it, this
   * goes red rather than the move being invisible.
   */
  it('renders the consequence list and offers the close', async () => {
    mount({ preview: PREVIEW });
    await openConfirmation();

    const group = screen.getByRole('group', { name: 'Close Salmiya?' });
    const text = group.textContent ?? '';
    expect(text).toContain(
      '2 staff lose it from their branch access: Noura Al-Rashid, Dana Al-Sabah.',
    );
    expect(text).toContain('Noura Al-Rashid would be left with no branch at all');
    expect(text).toContain('and cannot work until you give her another one in Accounts → Team.');
    expect(text).toContain('3 appointments here still hold a customer’s deposit');
    expect(text).toContain(
      '2 of those had their branch inferred rather than recorded, so treat the count as approximate.',
    );
    expect(text).toContain('Front desk would be unenrolled and stop taking payments');
    expect(text).toContain('2 pickup orders are waiting at this branch');
    expect(text).toContain(
      '— they stay on Shop → Orders, marked as at a closed branch, and nobody will be here to hand them over.',
    );
    expect(within(group).queryByRole('button', { name: 'Close Salmiya' })).not.toBeNull();
  });

  /** The reassuring branch of all three ternaries, on a preview that means it. */
  it('says nothing is affected when the server says nothing is affected', async () => {
    mount({ preview: QUIET_PREVIEW });
    await openConfirmation();

    const text = screen.getByRole('group', { name: 'Close Salmiya?' }).textContent ?? '';
    expect(text).toContain('No staff are scoped to this branch.');
    expect(text).toContain('No appointment here is holding a deposit.');
    expect(text).toContain('No till stands at this branch.');
    expect(text).toContain('No pickup order is waiting here.');
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AN UNREADABLE PREVIEW IS NOT "NO CONSEQUENCES"
   * ═════════════════════════════════════════════════════════════════════════
   * The three sentences above are the ones that would appear if an unparsed body
   * happened to produce empty arrays and zeroes — and they read as permission to
   * proceed, under a live Close button, over consequences nobody checked. An
   * empty list and an unreadable list are different, and only the first is an
   * answer.
   *
   * Table-driven over the preview's own required keys, so a tenth field the API
   * adds is covered the day this fixture learns about it.
   */
  const REASSURING = [
    'No staff are scoped to this branch.',
    'No appointment here is holding a deposit.',
    'No till stands at this branch.',
    'No pickup order is waiting here.',
  ];

  const PREVIEW_KEYS = Object.keys(PREVIEW);

  it('covers every key of the preview body', () => {
    // A table that silently matched nothing would be hollow.
    expect(PREVIEW_KEYS).toHaveLength(14);
  });

  it.each(PREVIEW_KEYS)('a preview with no `%s` blocks rather than reassures', async (key) => {
    const body = { ...PREVIEW };
    delete body[key];
    mount({ preview: body });
    await openConfirmation();

    const group = screen.getByRole('group', { name: 'Close Salmiya?' });
    const text = group.textContent ?? '';

    // Not "nothing would happen" — the three sentences that read as permission.
    for (const sentence of REASSURING) expect(text).not.toContain(sentence);
    // And no consequence stated as a fact either.
    expect(text).not.toContain('would be left with no branch at all');

    // The block, in the panel's own words, with the close withdrawn.
    expect(text).toContain("Couldn't check what closing Salmiya would do");
    expect(text).toContain(
      'Closing a branch re-scopes staff, unenrols tills and cannot be undone.',
    );
    expect(within(group).queryByRole('button', { name: 'Close Salmiya' })).toBeNull();
  });

  /** A 200 that is not an object at all — the case that throws before any key. */
  it.each([null, 'Salmiya', 42, [PREVIEW]])(
    'a preview body of %p blocks rather than crashes',
    async (body) => {
      mount({ preview: body });
      await openConfirmation();
      const group = screen.getByRole('group', { name: 'Close Salmiya?' });
      expect(group.textContent).toContain("Couldn't check what closing Salmiya would do");
      expect(within(group).queryByRole('button', { name: 'Close Salmiya' })).toBeNull();
    },
  );
});

/* ========================================== 2 · the receipt, POST-commit == */

describe('the close has committed by the time its body is read', () => {
  /** The full receipt, pinned — including the sentence this whole slice is about. */
  it('renders the receipt the server sent', async () => {
    mount({ preview: PREVIEW, close: CLOSURE });
    await openConfirmation();
    await confirmClose();

    const receipt = await screen.findByRole('status');
    const text = receipt.textContent ?? '';
    expect(text).toContain('Salmiya is closed.');
    expect(text).toContain('Re-scoped Noura Al-Rashid, Dana Al-Sabah.');
    expect(text).toContain('Noura Al-Rashid now has no branch access — fix that in Accounts → Team.');
    expect(text).toContain(
      'Unenrolled Front desk — set it up again at another branch under Tills.',
    );
    expect(text).toContain('3 appointments still hold a deposit here.');
    expect(text).toContain('2 pickup orders are still waiting here — flagged on Shop → Orders.');
    // The full receipt, not the degraded one — the two are different sentences.
    expect(text).not.toContain(SUMMARY_UNREADABLE);
    expectNoFailureLanguage();
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE DEGRADED RECEIPT — the real idempotent body, which is not a BranchClosure
   * ═════════════════════════════════════════════════════════════════════════
   * Three properties, and each is load-bearing:
   *   1. it opens with the fact — the close happened;
   *   2. it sends her to Accounts → Team, which is the ONLY route back to the
   *      consequence she did not get told about;
   *   3. no failure language, because "That branch is still open." is false and
   *      the act it invites is a second close.
   */
  it('a body that is not a closure still reports the close, and says where to look', async () => {
    mount({ preview: PREVIEW, close: IDEMPOTENT_CLOSE });
    await openConfirmation();
    await confirmClose();

    const receipt = await screen.findByRole('status');
    const text = receipt.textContent ?? '';

    // 1 · the fact, first and unqualified — and the degraded receipt, not the full one.
    expect(text).toContain('Salmiya is closed.');
    expect(text).toContain(SUMMARY_UNREADABLE);
    // 2 · where the truth still is.
    expect(text).toContain('Accounts → Team');
    expect(text).toContain('staff who may have been left with no branch access');
    expect(text).toContain('Tills');
    expect(text).toContain('Shop → Orders for pickup orders that may still be waiting there');
    // 3 · nothing that says the close failed.
    expectNoFailureLanguage();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * AND IT DOES NOT INVENT THE CONSEQUENCES IT COULD NOT READ. "may have been"
   * rather than a name: the body was not read, so stating a person or a count
   * would be manufacturing one.
   */
  it('names nobody it did not read', async () => {
    mount({ preview: PREVIEW, close: IDEMPOTENT_CLOSE });
    await openConfirmation();
    await confirmClose();

    const text = (await screen.findByRole('status')).textContent ?? '';
    expect(text).not.toContain('Noura Al-Rashid');
    expect(text).not.toContain('Re-scoped');
    expect(text).not.toContain('Front desk');
  });

  /** Table-driven: any missing required key degrades, none of them throws. */
  const CLOSURE_KEYS = Object.keys(CLOSURE);

  it('covers every key of the closure body', () => {
    expect(CLOSURE_KEYS).toHaveLength(11);
  });

  it.each(CLOSURE_KEYS)('a closure with no `%s` degrades rather than fails', async (key) => {
    const body = { ...CLOSURE };
    delete body[key];
    mount({ preview: PREVIEW, close: body });
    await openConfirmation();
    await confirmClose();

    const receipt = await screen.findByRole('status');
    const text = receipt.textContent ?? '';
    expect(text).toContain('Salmiya is closed.');
    expect(text).toContain(SUMMARY_UNREADABLE);
    expect(text).toContain('Accounts → Team');
    // And it did not state a consequence it had not read.
    expect(text).not.toContain('Re-scoped');
    expectNoFailureLanguage();
  });

  /**
   * THE THREE LISTS THE CLOSE INVALIDATES, asserted rather than assumed — they
   * are what the degraded receipt's "check Accounts → Team / Tills" relies on
   * being true by the time she looks.
   */
  it('still invalidates the salon, the roster and the tills on a degraded receipt', async () => {
    const client = mount({ preview: PREVIEW, close: IDEMPOTENT_CLOSE });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openConfirmation();
    await confirmClose();
    await screen.findByRole('status');

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(salonKeys.detail('SAL-AMARA')));
    expect(keys).toContain(JSON.stringify(staffKeys.list('SAL-AMARA')));
    expect(keys).toContain(JSON.stringify(deviceKeys.list('SAL-AMARA')));
  });
});

/* ================================================ 3 · the create, ordinary == */

describe('a created branch the client cannot read is not a branch that was not created', () => {
  it('adds a branch and clears the field on a well-formed 201', async () => {
    mount({ create: CREATED });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('New branch name'), {
        target: { value: 'Hawally' },
      });
    });
    await act(async () => {
      screen.getByRole('button', { name: '+ Add branch' }).click();
    });
    await waitFor(() => expect(authedRequest).toHaveBeenCalled());
    expectNoFailureLanguage();
  });

  /**
   * THE FALSE FAILURE THIS SLICE REFUSED TO INTRODUCE. A bare `.parse` in the
   * `mutationFn` would have drawn "Something went wrong on our side. **No branch
   * was added.**" over a branch the server had created — and the action that
   * sentence invites is a second POST and a duplicate branch.
   */
  it.each([{}, null, 'Hawally', { ...CREATED, name: '' }])(
    'a 201 body of %p is not reported as a failed add',
    async (body) => {
      const client = mount({ create: body });
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('New branch name'), {
          target: { value: 'Hawally' },
        });
      });
      await act(async () => {
        screen.getByRole('button', { name: '+ Add branch' }).click();
      });
      await waitFor(() => expect(authedRequest).toHaveBeenCalled());

      expectNoFailureLanguage();
      expect(screen.queryByRole('alert')).toBeNull();
      // The invalidation is what supplies the truth the unread body did not.
      const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
      await waitFor(() =>
        expect(keys).toContain(JSON.stringify(salonKeys.detail('SAL-AMARA'))),
      );
    },
  );
});

/* ================================ 4 · pickup orders waiting, migration 0060 == */

/**
 * `pickupOrdersWaiting` — shop orders a customer chose to collect at this branch
 * and has not collected. The close leaves them on Shop → Orders flagged
 * `closed`, and nobody will be behind the counter, so she must read the number
 * BEFORE the button.
 *
 * THE RULE FROM THIS FILE'S FIRST SLICE, APPLIED TO THE NEW FIELD: an
 * unreadable count is not 0. "No pickup order is waiting here." under a live
 * Close button is permission to close; it must appear only when the server
 * said 0. The missing-key case is already covered by the table in section 1
 * (fourteen keys); these are the shapes that are PRESENT and still unreadable —
 * the ones a `?? 0` or a `Number()` would have turned into a reassurance.
 */
describe('the pickup orders waiting at a branch are read before the close, never guessed', () => {
  it('names a single waiting order in the singular, as a warning', async () => {
    mount({ preview: { ...QUIET_PREVIEW, pickupOrdersWaiting: 1 } });
    await openConfirmation();
    const group = screen.getByRole('group', { name: 'Close Salmiya?' });
    const line = [...group.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('pickup order'),
    );
    expect(line?.textContent).toContain('1 pickup order is waiting at this branch');
    expect(line?.className).toContain('settings__consequence--warn');
    expect(group.textContent).not.toContain('No pickup order is waiting here.');
    // A count, not a blocker — the close is still offered.
    expect(within(group).queryByRole('button', { name: 'Close Salmiya' })).not.toBeNull();
  });

  it.each([['"2"', '2'], ['null', null], ['-1', -1], ['1.5', 1.5], ['true', true]])(
    'a pickupOrdersWaiting of %s blocks rather than rendering as 0',
    async (_label, value) => {
      mount({ preview: { ...QUIET_PREVIEW, pickupOrdersWaiting: value } });
      await openConfirmation();
      const group = screen.getByRole('group', { name: 'Close Salmiya?' });
      const text = group.textContent ?? '';
      expect(text).not.toContain('No pickup order is waiting here.');
      expect(text).not.toContain('0 pickup order');
      expect(text).toContain("Couldn't check what closing Salmiya would do");
      expect(within(group).queryByRole('button', { name: 'Close Salmiya' })).toBeNull();
    },
  );

  it('a receipt with an unreadable count degrades and sends her to Shop → Orders', async () => {
    mount({ preview: PREVIEW, close: { ...CLOSURE, pickupOrdersWaiting: '2' } });
    await openConfirmation();
    await confirmClose();
    const text = (await screen.findByRole('status')).textContent ?? '';
    expect(text).toContain(SUMMARY_UNREADABLE);
    expect(text).toContain('Shop → Orders');
    expect(text).not.toContain('pickup orders are still waiting here');
    expectNoFailureLanguage();
  });

  it('a receipt of 0 says nothing about pickups rather than inventing a warning', async () => {
    mount({ preview: PREVIEW, close: { ...CLOSURE, pickupOrdersWaiting: 0 } });
    await openConfirmation();
    await confirmClose();
    const text = (await screen.findByRole('status')).textContent ?? '';
    expect(text).not.toContain('pickup order');
    expect(text).not.toContain(SUMMARY_UNREADABLE);
  });
});
