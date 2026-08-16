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

/** Mint a live wallet token. Server-minted, 45s, single use at charge time. */
export async function mintWalletToken(): Promise<string> {
  const res = await api<{ token: string; expiresAt: string }>('GET', '/members/me/wallet-token');
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`Could not mint a wallet token: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

// --------------------------------------------------------- fixture constants --
// From packages/mock/src/fixtures.ts. Asserting against named constants keeps a
// fixture change loud instead of turning a suite into a tautology.

export const MEMBER_ID = '8842';
export const SALON_ID = 'SAL-AMARA';
/** Dana's balance in the default scenario. */
export const BALANCE_FILS = 24_500;
/** `lowbal` pins the balance here so the shortfall arithmetic is checkable. */
export const LOWBAL_BALANCE_FILS = 2_500;

export const SERVICE = {
  blowDry: { id: 'SV-01', priceFils: 8_000 },
  cutAndStyle: { id: 'SV-02', priceFils: 15_000 },
  colourRoots: { id: 'SV-03', priceFils: 25_000 },
} as const;
