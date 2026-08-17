/**
 * The HTTP client the suites use.
 *
 * Deliberately a bare `fetch` wrapper with no @avo/types imports. A test that
 * computes its expected commission with `commissionFor()` — the same function the
 * server used — asserts nothing at all. The expected numbers in these suites are
 * written out as literals from design/api-contract.md, so the test and the
 * implementation can actually disagree.
 */

import { randomUUID } from 'node:crypto';

export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) {
    throw new Error(
      'E2E_BASE_URL is not set, which means the global setup did not run.\n' +
        'Run the suite with `pnpm --filter @avo/e2e test`, or point it at a running API:\n' +
        '  E2E_BASE_URL=http://localhost:4000 pnpm --filter @avo/e2e test',
    );
  }
  return url;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  /** `x-avo-scenario` — the mock's principal/state switch. `noperms` is the restricted staff member. */
  scenario?: string;
  /** `Idempotency-Key`. Omitted on purpose in the tests that prove it is required. */
  idempotencyKey?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.scenario) headers['x-avo-scenario'] = options.scenario;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text; // an HTML error page or a gateway stub; the test can assert on it
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

/** A fresh idempotency key. Never reuse one across tests — the server remembers. */
export function idempotencyKey(label: string): string {
  return `${label}-${randomUUID()}`;
}

/**
 * Mint a live wallet token. Server-minted, 45s, single use at charge time.
 *
 * `scenario` MATTERS AND IS NOT OPTIONAL IN PRACTICE. Against `packages/mock`
 * there is one member and the header changes nothing. Against the real API,
 * `x-avo-scenario: lowbal` selects a DIFFERENT SEEDED MEMBER — the mock could
 * substitute a fake balance, a real API cannot lie about the money, so the
 * scenario changes whose wallet is in play. A token minted without the header
 * and then presented on a `lowbal` charge belongs to the wrong customer, and
 * lane A's token/member check correctly answers 409 `token_member_mismatch`
 * rather than the 402 the spec was after. Pass the same scenario to both calls.
 */
export async function mintWalletToken(scenario?: string): Promise<string> {
  const res = await api<{ token: string; memberId: string }>('GET', '/members/me/wallet-token', {
    ...(scenario === undefined ? {} : { scenario }),
  });
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`Could not mint a wallet token: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/**
 * WHICH SERVER IS ON THE OTHER END.
 *
 * These suites drive two things: `packages/mock` by default, and lane A's real
 * API under `E2E_BASE_URL`. For almost everything that is invisible and should
 * stay invisible — the whole point of writing to the contract is that both must
 * satisfy it.
 *
 * There is one class of spec where it cannot stay invisible: behaviour lane A has
 * implemented and the mock has NOT. Left as a `knownBug()`, such a spec reports
 * "this appears to be FIXED" every single run against the real API — which is the
 * helper working exactly as designed, and useless as a standing signal. Left as a
 * plain `it()`, it is permanently red against the mock. Neither is a true
 * statement about both servers, so the suite has to know which one it is talking
 * to and say so out loud.
 *
 * The probe is a real observable difference rather than an environment variable:
 * the mock's `/_health` advertises its scenario switch, lane A's does not. An
 * env var would be a claim; this is evidence.
 */
export type TargetKind = 'mock' | 'api';

let cachedTarget: TargetKind | undefined;

export async function targetKind(): Promise<TargetKind> {
  if (cachedTarget) return cachedTarget;
  const res = await api<{ ok?: boolean; scenarios?: string }>('GET', '/_health');
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`Nothing healthy answered ${baseUrl()}/_health: ${res.status}`);
  }
  cachedTarget = typeof res.body.scenarios === 'string' ? 'mock' : 'api';
  return cachedTarget;
}

export interface MemberSnapshot {
  balanceFils: number;
  visits: number;
  tier: string;
}

/**
 * The member as she is RIGHT NOW.
 *
 * THE REASON THIS EXISTS. These suites were written against `packages/mock`,
 * whose fixture is rebuilt in memory on every boot and therefore never moves. So
 * they asserted absolutes: balance 24.500, visits 5, Silver's 10%. Pointed at
 * the real API those became assertions about how many previous runs had happened
 * — Dana is charged and topped up by three suites, `applyVisits` walks her up the
 * tier ladder, and nothing resets her. She reached Black on 30% and 300+ KD, and
 * ten specs went red without a single defect behind them.
 *
 * A shared fixture that accumulates is a suite with a shelf life. Where a suite
 * can own its fixture it should — `e2e/support/tenancy-harness.ts` seeds and
 * resets its own member for exactly this reason. These three suites cannot: they
 * must keep running against the mock with no Postgres and no docker, so they
 * have nothing to seed with and no way to reset.
 *
 * What they can do is stop asserting absolutes. Read the state first, assert the
 * DELTA and the RATE. `balanceAfter === before − price` is the invariant that was
 * always meant; `24_500 − 8_000` was only ever a way of writing it down.
 */
export async function memberNow(scenario?: string): Promise<MemberSnapshot> {
  const res = await api<MemberSnapshot>('GET', '/members/me', {
    ...(scenario === undefined ? {} : { scenario }),
  });
  if (res.status !== 200) {
    throw new Error(`Could not read the member: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/**
 * Make sure the shared member can afford what the spec is about to do.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT "TOPPING UP TO MAKE A TEST PASS"
 * ------------------------------------------------------------------
 * `memberNow()` above solved half of the shared-fixture problem: stop asserting
 * absolutes, assert the delta. The other half only appeared once lane A's seed
 * was actually re-run. Dana is seeded at 24.500 KD; `concurrency.test.ts` needs
 * six settled charges of 8.000 KD, so from a clean seed the fourth charge is a
 * genuine 402 and three specs about idempotency and token races go red for a
 * reason that has nothing to do with idempotency or token races.
 *
 * Those specs had been green for weeks — because Dana had drifted up past
 * 300 KD across accumulated runs and nothing had reset her. So the suite was
 * passing on drift, and the day the database was seeded properly it broke. A
 * suite that only works on an un-reset database is not a suite.
 *
 * The money moved here is REAL, through the real path: `POST /topups` creates an
 * intent, the sandbox PSP's hosted page settles it, and the signed callback
 * credits the wallet. Nothing writes a balance directly, so this cannot paper
 * over a broken credit path — if the top-up path is broken this throws and every
 * spec downstream fails loudly.
 *
 * AGAINST `packages/mock` THIS IS INERT, BY TARGET AND NOT BY LUCK. The mock's
 * fixture is rebuilt in memory at boot and its balance never moves however many
 * charges settle against it, so no floor can ever be crossed there and there is
 * nothing to fund. Checking the balance instead would be wrong for the same
 * reason it is wrong everywhere else in this file: 24.500 is smaller than a
 * ten-charge floor, so the helper would try to top up a server that has no
 * gateway and take the whole file down in `beforeAll`.
 *
 * NEVER call this with the `lowbal` scenario. That member's shortfall IS the
 * fixture — funding her would delete the 402 specs.
 */
export async function ensureBalanceAtLeast(minFils: number, label = 'fixture'): Promise<number> {
  const current = (await memberNow()).balanceFils;
  if (current >= minFils) return current;
  // The mock's balance is static; a floor is meaningless against it.
  if ((await targetKind()) === 'mock') return current;

  // Round up to a whole KD above the floor, so one top-up covers several specs
  // rather than one per charge.
  const shortfall = minFils - current;
  const amountFils = Math.ceil(shortfall / 1_000) * 1_000;

  const created = await api<{ id: string; redirectUrl?: string }>('POST', '/topups', {
    idempotencyKey: idempotencyKey(`ensure-balance-${label}`),
    body: { amountFils, method: 'knet' },
  });
  if (created.status !== 200) {
    throw new Error(
      `The shared member is short ${shortfall} fils and POST /topups answered ` +
        `${created.status} ${JSON.stringify(created.body)}.\n` +
        'Re-seed lane A\'s fixture:  pnpm --filter @avo/api run db:seed',
    );
  }

  // The sandbox driver's hosted page. `POST /_gateway/{ref}` is what a customer
  // pressing "pay" does, so it needs no credential and no webhook secret — which
  // is the only reason a suite pointed at an arbitrary E2E_BASE_URL can drive it.
  const ref = /\/_gateway\/([^/?#]+)/.exec(created.body.redirectUrl ?? '')?.[1];
  if (!ref) {
    throw new Error(
      `The shared member is short ${shortfall} fils and this API's top-up does not go ` +
        `through the sandbox gateway (redirectUrl: ${created.body.redirectUrl ?? '(none)'}).\n` +
        'This suite cannot fund her against a real processor. Re-seed instead:\n' +
        '  pnpm --filter @avo/api run db:seed',
    );
  }

  const settled = await api('POST', `/_gateway/${ref}`, {
    body: { outcome: 'succeeded', notify: true },
  });
  if (settled.status !== 200) {
    throw new Error(
      `The sandbox gateway refused to settle ${ref}: ${settled.status} ${JSON.stringify(settled.body)}`,
    );
  }

  const after = (await memberNow()).balanceFils;
  if (after < minFils) {
    throw new Error(
      `Funded the shared member with ${amountFils} fils and she is still below ${minFils} ` +
        `(now ${after}). The top-up settled but the wallet did not move — that is a real defect, ` +
        'not a fixture problem.',
    );
  }
  return after;
}

// --------------------------------------------------------- fixture constants --
// From packages/mock/src/fixtures.ts. Asserting against named constants keeps a
// fixture change loud instead of turning a suite into a tautology.

export const MEMBER_ID = '8842';
export const SALON_ID = 'SAL-AMARA';
/**
 * Dana's balance in the mock's default scenario.
 *
 * Correct against `packages/mock` and NOT a safe expectation against a real
 * database — see `memberNow()`. Kept because the mock-shaped specs that pin the
 * mock's own behaviour are still entitled to it; anything asserting an
 * invariant about money reads the balance instead.
 */
export const BALANCE_FILS = 24_500;
/** `lowbal` pins the balance here so the shortfall arithmetic is checkable. */
export const LOWBAL_BALANCE_FILS = 2_500;

/**
 * The tier ladder, from design/api-contract.md § Commission.
 *
 * THE literal in the bonus specs. The member's tier is read at runtime (it
 * drifts), the RATE for that tier is fixed by the contract (it does not), and
 * the product of the two is what the server must have computed.
 */
export const TIER_BONUS_PERCENT: Record<string, number> = {
  bronze: 0,
  silver: 10,
  gold: 20,
  black: 30,
};

export const SERVICE = {
  blowDry: { id: 'SV-01', priceFils: 8_000 },
  cutAndStyle: { id: 'SV-02', priceFils: 15_000 },
  colourRoots: { id: 'SV-03', priceFils: 25_000 },
} as const;
