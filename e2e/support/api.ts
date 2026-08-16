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
