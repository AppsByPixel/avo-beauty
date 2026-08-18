/**
 * THE STAFF SCANNER — the surface a salon actually touches.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run scanner.test.ts
 *
 * Like `tenancy.test.ts`, `gateway.test.ts` and `integration.test.ts` and unlike
 * the three mock-driven files, this boots lane A's real API against lane D's own
 * Postgres — `support/tenancy-harness.ts` explains the mechanics and why the
 * database is not the shared one.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Lane B built the scanner and verified the money path against the database.
 * That is a real check and it is not this one: it proves the API did the right
 * thing when lane B drove it, and says nothing about what the API does next month
 * when someone edits `requireScannerPerm` or the void window. Nothing in this
 * suite exercised the scanner's endpoints at all, so the surface with the most
 * authority in the product — the one that debits a wallet in front of a customer —
 * was the least covered.
 *
 * EVERY PRINCIPAL HERE IS REAL. No `AVO_TEST_PRINCIPALS`, anywhere in this file.
 * A scanner session comes from `POST /staff/session` with a four-digit PIN on a
 * bound device; the customer's QR comes from a member who signed in with a phone
 * number and a password. That matters more here than anywhere else in the suite,
 * because the PIN's controls ARE the security model — hashed, device-scoped,
 * rate-limited, locked after five failures, scanner scope only — and the shim
 * resolves a principal by URL prefix, which is to say it has none of them. A
 * scanner proven under the shim is a property of the shim.
 *
 * THE FIXTURES, AND WHY THERE ARE FOUR STAFF ROWS
 * ----------------------------------------------
 * Three of the specs below are destructive to the row they act on: a lockout
 * leaves `pin_locked_until` fifteen minutes out, and a rate-limit test leaves a
 * device refused for five. Run against one staff member they would sign the rest
 * of the file out of the scanner. So each destructive spec gets a row and a
 * device of its own — see the constants in `support/tenancy-harness.ts`.
 *
 *   Layla  ST-B01  all nine permissions      the working scanner
 *   Noor   ST-B03  scanner on, charges off   the locked screen's principal
 *   Huda   ST-B04  exists to be locked out
 *   Dalal  ST-B05  exists to be rate limited
 *
 * All of them are at salon B, whose fixtures this suite owns and resets on every
 * run. Salon A's Dana is never touched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import {
  A_MEMBER,
  B_BRANCH,
  B_LOCKOUT_DEVICE,
  B_MEMBER,
  B_MEMBER_PHONE,
  B_RATELIMIT_DEVICE,
  B_RESTRICTED_DEVICE,
  B_SCANNER_DEVICE,
  B_SERVICE,
  B_SERVICE_PRICE_FILS,
  B_STAFF,
  B_STAFF_HANDLE,
  B_STAFF_LOCKOUT,
  B_STAFF_LOCKOUT_HANDLE,
  B_STAFF_PIN,
  B_STAFF_BURST,
  B_STAFF_BURST_HANDLE,
  B_BURST_DEVICE,
  B_STAFF_CROSSDOOR,
  B_STAFF_CROSSDOOR_HANDLE,
  B_CROSSDOOR_DEVICE,
  B_STAFF_COUNTER,
  B_STAFF_COUNTER_HANDLE,
  B_COUNTER_DEVICE,
  B_STAFF_RATELIMIT,
  B_STAFF_RATELIMIT_HANDLE,
  B_STAFF_RESTRICTED,
  B_STAFF_RESTRICTED_HANDLE,
  B_WRONG_PIN,
  PIN_DEVICE_ATTEMPTS_PER_WINDOW,
  PIN_MAX_ATTEMPTS,
  SALON_A,
  SALON_B,
  attemptScannerSignIn,
  mintWalletTokenFor,
  psql,
  repoRoot,
  resetPinState,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** api/src/services/charge.ts — `VOID_WINDOW_MINUTES`. Written out, not imported. */
const VOID_WINDOW_MINUTES = 15;

/** Layla's scanner session. Full authority; the control for every refusal below. */
let scanner = '';
/** Noor's scanner session. `scanner` on, `charges` and `void` off. */
let restricted = '';
/** Fatima's wallet session — salon B's own customer, signed in for real. */
let wallet = '';

let n = 0;
const key = (label: string) => `scan-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  scanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  restricted = await signInScanner(SALON_B, B_STAFF_RESTRICTED_HANDLE, B_RESTRICTED_DEVICE);
  wallet = await signInMember(SALON_B, B_MEMBER_PHONE);
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ------------------------------------------------------------------- reads --

const balanceOf = (memberId: string): number =>
  Number(scalar(`select balance_fils from member where id='${memberId}'`));

const visitsOf = (memberId: string): number =>
  Number(scalar(`select visits from member where id='${memberId}'`));

const pinStateOf = (staffId: string): string =>
  scalar(
    `select pin_failed_attempts::text || ':' || (pin_locked_until is not null)::text
       from staff_user where id='${staffId}'`,
  );

/** A live QR for salon B's customer. Minted through her own wallet session. */
const freshWalletToken = (): Promise<string> => mintWalletTokenFor(wallet, B_MEMBER);

interface ChargeResult {
  transaction: {
    id: string;
    memberId: string;
    kind: string;
    amountFils: number;
    status: string;
    reference: string;
  };
  balanceAfterFils: number;
  depositAppliedFils: number;
  voidableUntil: string;
}

/**
 * A settled charge against salon B's customer, made the way the scanner makes
 * one: a fresh QR, then `POST /charges` on a real PIN session.
 */
async function chargeOnce(label: string): Promise<ChargeResult> {
  const token = await freshWalletToken();
  const res = await treq<ChargeResult>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key(label),
    body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
  });
  precondition(res.status === 200, `POST /charges answered ${res.status} ${res.raw}`);
  return res.body;
}

// ===========================================================================
// THE PIN — api-contract.md § StaffUser
// ===========================================================================

/**
 * "Staff scanner authenticates by 4-digit PIN scoped to a device+salon. PIN is
 * not a password: rate-limit it, lock after N failures, and never let it reach
 * dashboard scopes."
 *
 * Four digits is ten thousand possibilities, which is nothing on its own. Every
 * spec in this block is one of the four things that make it safe anyway, and the
 * point of testing them individually is that they do not cover each other: an
 * account lockout does nothing against an attacker who rotates handles, and a
 * device limit does nothing against one who hammers a single account from many
 * devices.
 */
describe('PIN sign-in', () => {
  it('a correct PIN on the bound device mints a scanner session', async () => {
    const res = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });

    expect(res.status, res.raw).toBe(200);
    expect(res.body.accessToken, 'no access token on a successful PIN sign-in').toBeTruthy();
    expect(res.body.staff?.id).toBe(B_STAFF);
  });

  it('and returns no PIN, PIN hash or password anywhere in the response (non-negotiable #6)', async () => {
    const res = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });
    precondition(res.status === 200, `sign-in answered ${res.status}`);

    // The whole document, at any depth — the PIN was in the request, so a
    // serialiser echoing the row back is the failure mode.
    expect(res.raw).not.toMatch(/pinHash|pin_hash|passwordHash|password_hash/i);
    expect(res.raw).not.toMatch(new RegExp(`"pin"\\s*:|${B_STAFF_PIN}`));
  });

  it('the session it mints is `scanner` scope and cannot reach the dashboard', async () => {
    // The fourth control, and the one that makes the other three worth having.
    // A PIN that could mint dashboard authority would make its own limits moot.
    const res = await treq<{ error: string; message: string }>('GET', '/staff', {
      token: scanner,
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/scanner PIN cannot reach the dashboard/i);
  });

  it('a wrong PIN is refused', async () => {
    const res = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_WRONG_PIN,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(res.body.accessToken).toBeUndefined();
  });

  /**
   * THE ENUMERATION PROPERTY, ASSERTED AS AN EQUALITY RATHER THAN THREE TIMES.
   *
   * A sign-in form that distinguishes "no such handle" from "wrong PIN" from
   * "right PIN, wrong device" is a staff-roster oracle, and the third one is
   * worse than the other two: it confirms a correct PIN to whoever is holding a
   * stolen tablet. Asserting each of the three is a 401 individually would not
   * catch a build that gave them three different messages, so what is asserted is
   * that the three responses are INDISTINGUISHABLE.
   */
  it('an unknown handle, a wrong PIN and a wrong device are indistinguishable', async () => {
    const unknownHandle = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: 'nobody-by-this-name',
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });
    const wrongPin = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_WRONG_PIN,
    });
    // The right PIN for a real person, presented from a device it was never
    // bound to. `staff_user.pin_device_id` is the gate.
    const wrongDevice = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: 'DEV-STOLEN-TABLET',
      pin: B_STAFF_PIN,
    });

    for (const [what, res] of [
      ['unknown handle', unknownHandle],
      ['wrong PIN', wrongPin],
      ['wrong device', wrongDevice],
    ] as const) {
      expect(res.status, `${what} answered ${res.status}: ${res.raw}`).toBe(401);
    }

    // Byte for byte. A difference of one word is a difference an attacker scripts.
    expect(
      wrongPin.raw,
      'a wrong PIN and an unknown handle are distinguishable — the sign-in is a roster oracle',
    ).toBe(unknownHandle.raw);
    expect(
      wrongDevice.raw,
      'the right PIN from the wrong device answers differently, which confirms the PIN to ' +
        'somebody holding a stolen device',
    ).toBe(unknownHandle.raw);
  });

  it('a PIN that is not four digits is refused before any lookup', async () => {
    for (const bad of ['123', '123456', 'abcd', '', 1234]) {
      const res = await attemptScannerSignIn({
        salonId: SALON_B,
        handle: B_STAFF_HANDLE,
        deviceId: B_SCANNER_DEVICE,
        pin: bad,
      });
      expect(res.status, `pin ${JSON.stringify(bad)} answered ${res.status}`).toBe(400);
      expect(res.body.error).toBe('invalid_pin_format');
    }
  });

  it('a PIN is scoped to its salon — the same handle and PIN at salon A is refused', async () => {
    // `staff_user_salon_handle_uq` is on (salon_id, handle), so a handle is not a
    // person. Layla exists at salon B only.
    const res = await attemptScannerSignIn({
      salonId: SALON_A,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });
});

// ------------------------------------------------------------- the lockout --

describe('PIN lockout — "lock after N failures"', () => {
  it(`the ${PIN_MAX_ATTEMPTS}th consecutive wrong PIN locks the account`, async () => {
    // Counting from a known zero rather than from whatever ran before. See
    // `resetPinState` for the failure this prevents.
    resetPinState(B_STAFF_LOCKOUT, B_LOCKOUT_DEVICE);
    precondition(
      pinStateOf(B_STAFF_LOCKOUT) === '0:false',
      `${B_STAFF_LOCKOUT} did not start unlocked with a zero counter`,
    );

    const statuses: number[] = [];
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      const res = await attemptScannerSignIn({
        salonId: SALON_B,
        handle: B_STAFF_LOCKOUT_HANDLE,
        deviceId: B_LOCKOUT_DEVICE,
        pin: B_WRONG_PIN,
      });
      statuses.push(res.status);
    }

    // The first four are ordinary refusals; the fifth is the lock. Asserting the
    // shape of the whole sequence rather than only the last one is what proves
    // the threshold is N and not "always" or "eventually".
    expect(statuses.slice(0, PIN_MAX_ATTEMPTS - 1).every((s) => s === 401), `${statuses}`).toBe(
      true,
    );
    expect(statuses[PIN_MAX_ATTEMPTS - 1], `attempt ${PIN_MAX_ATTEMPTS} did not lock`).toBe(429);

    expect(pinStateOf(B_STAFF_LOCKOUT)).toBe(`${PIN_MAX_ATTEMPTS}:true`);
  });

  it('and the CORRECT PIN is then refused too — the lock is on the account, not the guess', async () => {
    // Depends on the spec above, deliberately: this is the half that makes a
    // lockout a lockout. A "lock" that still admits the right PIN is a rate
    // limit with extra steps, and an attacker who lands the PIN on attempt five
    // walks straight through it.
    const res = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_LOCKOUT_HANDLE,
      deviceId: B_LOCKOUT_DEVICE,
      pin: B_STAFF_PIN,
    });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('pin_locked');
    // The copy names the way out. design/AVO Staff Scanner.dc.html, locked state.
    expect(res.body.message).toMatch(/manager can unlock it/i);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('the lock is written down — a risk audit row names who locked and on what device', async () => {
    // api-contract.md § Operations. A lockout is a security event: if five wrong
    // PINs against a staff member leave no trace, nobody can tell a fat-fingered
    // morning from an attempt on the till.
    const row = scalar(
      `select kind::text || '|' || action || '|' || coalesce(subject_id,'-')
         from audit_log
        where salon_id='${SALON_B}' and subject_id='${B_STAFF_LOCKOUT}' and action='PIN locked'
        order by created_at desc limit 1`,
    );

    expect(row, 'a PIN lockout wrote no audit row').toBe(`risk|PIN locked|${B_STAFF_LOCKOUT}`);
  });

  it('a successful sign-in clears the counter, so four near-misses do not accumulate for ever', async () => {
    // Layla, not Huda — this needs a row that can still sign in. Four failures is
    // one short of the threshold, which is the case that matters: the counter has
    // to reset, or a member of staff who mistypes twice a week eventually locks
    // herself out of a PIN she knows.
    //
    // From a known zero: the refusal specs above legitimately left Layla on two,
    // so four more here would have locked her on the fifth and this spec would
    // have been measuring the wrong thing.
    resetPinState(B_STAFF, B_SCANNER_DEVICE);

    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
      await attemptScannerSignIn({
        salonId: SALON_B,
        handle: B_STAFF_HANDLE,
        deviceId: B_SCANNER_DEVICE,
        pin: B_WRONG_PIN,
      });
    }
    precondition(
      pinStateOf(B_STAFF) === `${PIN_MAX_ATTEMPTS - 1}:false`,
      `${B_STAFF} is at ${pinStateOf(B_STAFF)} after ${PIN_MAX_ATTEMPTS - 1} failures`,
    );

    const ok = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });
    expect(ok.status, ok.raw).toBe(200);
    expect(pinStateOf(B_STAFF)).toBe('0:false');
  });
});

// ------------------------------------------------------- the device limit --

describe('PIN rate limiting — per device, which is the control the lockout cannot be', () => {
  it(`${PIN_DEVICE_ATTEMPTS_PER_WINDOW} failures from one device refuse it, even with a correct PIN`, async () => {
    /**
     * THE ATTACK THIS EXISTS FOR.
     *
     * Every failure below is against a handle that does not exist. That walks the
     * per-DEVICE counter without touching a single account's counter, which is
     * exactly what an attacker with a stolen tablet does: rotate the handle, keep
     * every individual account comfortably below five, and work through the PIN
     * space unimpeded. The account lockout is blind to it by construction.
     *
     * `PIN_DEVICE_ATTEMPTS_PER_WINDOW` is deliberately larger than
     * `PIN_MAX_ATTEMPTS` in the harness, so the two thresholds cannot be confused
     * for one another: if this spec tripped the account lockout instead, it would
     * be asserting the wrong control.
     */
    resetPinState(B_STAFF_RATELIMIT, B_RATELIMIT_DEVICE);
    precondition(
      pinStateOf(B_STAFF_RATELIMIT) === '0:false',
      `${B_STAFF_RATELIMIT} did not start clean`,
    );

    for (let i = 0; i < PIN_DEVICE_ATTEMPTS_PER_WINDOW; i++) {
      const res = await attemptScannerSignIn({
        salonId: SALON_B,
        handle: `ghost-${i}`,
        deviceId: B_RATELIMIT_DEVICE,
        pin: B_WRONG_PIN,
      });
      expect(res.status, `attempt ${i + 1} against a ghost handle answered ${res.status}`).toBe(401);
    }

    // The next attempt is the real one — a genuine handle with the genuine PIN.
    // It must still be refused, and refused for the DEVICE rather than the
    // credential, which is what the distinct error code carries.
    const blocked = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_RATELIMIT_HANDLE,
      deviceId: B_RATELIMIT_DEVICE,
      pin: B_STAFF_PIN,
    });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
    expect(blocked.body.accessToken).toBeUndefined();

    // And nothing locked an account on the way. If the ghost attempts had moved
    // an account counter, the device limit would be doing the lockout's job and
    // the rotating-handle attack would still be open.
    expect(
      pinStateOf(B_STAFF_RATELIMIT),
      'the device rate limit locked an account, which means it is counting the wrong thing',
    ).toBe('0:false');
  });

  it('and the limit is scoped to that device — another device signs in fine', async () => {
    // Otherwise one attacker on one tablet takes the whole salon off the air,
    // which turns a security control into a denial of service.
    //
    // Layla's own device, cleared: the point is that DEV-SCANNER-B-RATELIMIT
    // being refused says nothing about DEV-SCANNER-B, and that is only a real
    // statement if this device starts from a clean history of its own.
    resetPinState(B_STAFF, B_SCANNER_DEVICE);

    const res = await attemptScannerSignIn({
      salonId: SALON_B,
      handle: B_STAFF_HANDLE,
      deviceId: B_SCANNER_DEVICE,
      pin: B_STAFF_PIN,
    });
    expect(res.status, res.raw).toBe(200);
  });
});

// ===========================================================================
// POST /scans — resolving the customer's QR
// ===========================================================================

describe('POST /scans', () => {
  it('resolves a live wallet token to the member card the scanner draws', async () => {
    const token = await freshWalletToken();
    const res = await treq<{
      member: { id: string; name: string; balanceFils: number; tier: string | null };
      heldDepositFils: number;
      services: Array<{ id: string; name: string; priceFils: number }>;
    }>('POST', '/scans', { token: scanner, body: { token } });

    expect(res.status, res.raw).toBe(200);
    expect(res.body.member.id).toBe(B_MEMBER);
    expect(res.body.member.balanceFils).toBe(balanceOf(B_MEMBER));
    // The service list is what the artist picks from, and it is salon-scoped.
    expect(res.body.services.map((s) => s.id)).toContain(B_SERVICE);
    expect(res.body.services.find((s) => s.id === B_SERVICE)?.priceFils).toBe(B_SERVICE_PRICE_FILS);
  });

  it('and never returns the customer\'s password hash', async () => {
    const token = await freshWalletToken();
    const res = await treq('POST', '/scans', { token: scanner, body: { token } });
    expect(res.raw).not.toMatch(/passwordHash|password_hash/i);
  });

  it('does NOT consume the token — re-reading the code before confirming must not burn it', async () => {
    // The scanner reads the QR to draw the card, and the artist then confirms.
    // Consumption belongs to the charge. If the scan burned it, every customer
    // who was shown her own total before agreeing would have to re-open the app.
    const token = await freshWalletToken();

    const first = await treq('POST', '/scans', { token: scanner, body: { token } });
    const second = await treq('POST', '/scans', { token: scanner, body: { token } });
    expect(first.status).toBe(200);
    expect(second.status, 'the first scan consumed the token').toBe(200);

    // And it is still good enough to charge with, which is the assertion that
    // matters — a scan that half-consumed the token would pass the two 200s above.
    const charged = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: key('scan-then-charge'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(charged.status, `the scanned token could not charge: ${charged.raw}`).toBe(200);
  });

  it('a token that was never minted is refused', async () => {
    const res = await treq<{ error: string }>('POST', '/scans', {
      token: scanner,
      body: { token: 'tok_never_minted_by_anyone' },
    });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('token_consumed_or_unknown');
  });

  it('a missing token is a 400, not a 500', async () => {
    const res = await treq<{ error: string }>('POST', '/scans', { token: scanner, body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('a wallet session cannot scan — a customer cannot resolve her own QR to a member card', async () => {
    const token = await freshWalletToken();
    const res = await treq('POST', '/scans', { token: wallet, body: { token } });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// POST /charges — the debit
// ===========================================================================

describe('POST /charges', () => {
  it('debits the wallet by the price of the basket and reports the balance after', async () => {
    const before = balanceOf(B_MEMBER);
    const visitsBefore = visitsOf(B_MEMBER);

    const result = await chargeOnce('charge-basic');

    // The response and the row agree, and both moved by exactly the price. The
    // amount on the transaction is NEGATIVE — it is a debit, and a charge stored
    // as a positive number is a charge that reconciles the wrong way.
    expect(result.transaction.amountFils).toBe(-B_SERVICE_PRICE_FILS);
    expect(result.transaction.status).toBe('settled');
    expect(result.balanceAfterFils).toBe(before - B_SERVICE_PRICE_FILS);
    expect(balanceOf(B_MEMBER)).toBe(before - B_SERVICE_PRICE_FILS);

    // Step 5 of api-contract.md § Charging — a charge is a visit.
    expect(visitsOf(B_MEMBER)).toBe(visitsBefore + 1);
  });

  it('offers a void deadline fifteen minutes out', async () => {
    const result = await chargeOnce('charge-voidable');
    const deadline = new Date(result.voidableUntil).getTime();
    const expected = Date.now() + VOID_WINDOW_MINUTES * 60_000;

    // Within a minute of fifteen minutes from now. Asserting the exact instant
    // would be asserting the clock; asserting "some time in the future" would
    // pass on a window of a year.
    expect(Math.abs(deadline - expected)).toBeLessThan(60_000);
  });

  it('consumes the token — the same QR cannot be charged twice', async () => {
    // The single-use half of the token. Without it, a scanner that kept the code
    // on screen could charge the same customer repeatedly with no new consent.
    const token = await freshWalletToken();

    const first = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: key('token-single-use-1'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });
    precondition(first.status === 200, `the first charge failed: ${first.raw}`);

    const balanceAfterFirst = balanceOf(B_MEMBER);

    // A DIFFERENT idempotency key, so nothing here is the replay guard doing the
    // work — this is the token being spent.
    const second = await treq<{ error: string }>('POST', '/charges', {
      token: scanner,
      idempotencyKey: key('token-single-use-2'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });

    expect(second.status, `a consumed token charged again: ${second.raw}`).toBe(410);
    expect(balanceOf(B_MEMBER), 'the refused second charge still moved money').toBe(
      balanceAfterFirst,
    );
  });

  it('requires an Idempotency-Key, and creates nothing without one', async () => {
    const before = balanceOf(B_MEMBER);
    const token = await freshWalletToken();

    const res = await treq<{ error: string }>('POST', '/charges', {
      token: scanner,
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('idempotency_key_required');
    expect(balanceOf(B_MEMBER)).toBe(before);
  });

  it('a replay with the same key debits once and returns the first result verbatim', async () => {
    // Non-negotiable #4, on the scanner's own money path. A tap that the salon's
    // wifi swallowed is retried by the client, and the customer must not pay
    // twice for one blow-dry.
    const token = await freshWalletToken();
    const k = key('charge-replay');
    const body = { memberId: B_MEMBER, serviceIds: [B_SERVICE], token };
    const before = balanceOf(B_MEMBER);

    const first = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: k,
      body,
    });
    const second = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: k,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);
    expect(balanceOf(B_MEMBER), 'a replayed charge debited twice').toBe(
      before - B_SERVICE_PRICE_FILS,
    );
  });

  it('a charge is refused for a member of another salon', async () => {
    // Salon B's scanner, salon A's customer. The tenancy suite proves this for
    // the salon-scoped URLs; the charge takes its member from the BODY, which is
    // a different door into the same room.
    const token = await freshWalletToken();
    const res = await treq('POST', '/charges', {
      token: scanner,
      idempotencyKey: key('charge-cross-salon'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE], token },
    });

    expect(res.status, `salon B charged salon A's customer: ${res.raw}`).not.toBe(200);
    expect([403, 404, 409]).toContain(res.status);
  });

  it('a dashboard session cannot charge, whatever it holds', async () => {
    // Restated here rather than left to integration.test.ts because this is the
    // file about the scanner: the PIN's four controls are worth nothing if the
    // long-lived browser session next door can debit a wallet.
    const token = await freshWalletToken();
    const res = await treq<{ message: string }>('POST', '/charges', {
      token: wallet,
      idempotencyKey: key('charge-from-wallet'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// GET /charges — today's charges, and perms.charges
// ===========================================================================

describe('GET /charges — the permission gate', () => {
  it('403s for a scanner principal with the permission off', async () => {
    const res = await treq<{ error: string; message: string }>('GET', '/charges', {
      token: restricted,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    // design/AVO Staff Scanner.dc.html, locked state.
    expect(res.body.message).toMatch(/permission to see today's charges/i);
  });

  it('and discloses nothing in the refusal — not a row, not a count', async () => {
    const res = await treq<Record<string, unknown>>('GET', '/charges', { token: restricted });
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('items');
    expect(res.raw).not.toMatch(/AVO-CHG|amountFils/);
  });

  it('the same endpoint serves a principal that holds it — the 403 was authority, not a broken route', async () => {
    const charged = await chargeOnce('charges-list-control');

    const res = await treq<{ items: Array<{ id: string; kind: string }> }>('GET', '/charges', {
      token: scanner,
    });

    expect(res.status, res.raw).toBe(200);
    expect(res.body.items.every((t) => t.kind === 'charge')).toBe(true);
    expect(
      res.body.items.map((t) => t.id),
      'the charge this spec just made is not in today\'s charges',
    ).toContain(charged.transaction.id);
  });

  it('and lists only this salon\'s charges', async () => {
    const res = await treq<{ items: Array<{ id: string; memberId: string }> }>('GET', '/charges', {
      token: scanner,
    });
    precondition(res.status === 200, `GET /charges answered ${res.status}`);

    const foreign = res.body.items.filter(
      (t) =>
        scalar(`select coalesce(salon_id,'') from transaction where id='${t.id}'`) !== SALON_B,
    );
    expect(foreign, "today's charges contains a row from another salon").toEqual([]);
  });
});

// ===========================================================================
// POST /voids — the undo at the counter
// ===========================================================================

describe('POST /voids', () => {
  it('inside the window, returns the money and removes the visit', async () => {
    const charged = await chargeOnce('void-inside');
    const balanceAfterCharge = balanceOf(B_MEMBER);
    const visitsAfterCharge = visitsOf(B_MEMBER);

    const res = await treq<{ ok: boolean; refundedFils: number; visitRemoved: boolean }>(
      'POST',
      '/voids',
      {
        token: scanner,
        idempotencyKey: key('void-inside'),
        body: { transactionId: charged.transaction.id, reason: 'customer changed her mind' },
      },
    );

    expect(res.status, res.raw).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refundedFils).toBe(B_SERVICE_PRICE_FILS);
    expect(balanceOf(B_MEMBER)).toBe(balanceAfterCharge + B_SERVICE_PRICE_FILS);
    expect(visitsOf(B_MEMBER)).toBe(visitsAfterCharge - 1);

    /**
     * REFUNDS ARE WALLET CREDIT — non-negotiable #5, "no cash, no card reversal,
     * on any surface, ever". The compensating row is an `adjustment` paid by
     * `wallet`, and it points back at the charge rather than editing it.
     */
    const reversal = scalar(
      `select kind::text || '|' || method::text || '|' || amount_fils::text
         from transaction where reverses_transaction_id='${charged.transaction.id}'`,
    );
    expect(reversal).toBe(`adjustment|wallet|${B_SERVICE_PRICE_FILS}`);

    // And the original charge is untouched. The ledger is append-only in spirit;
    // a void that edited the charge would erase the fact that it happened.
    expect(
      scalar(`select status::text from transaction where id='${charged.transaction.id}'`),
    ).toBe('settled');
  });

  it('refuses without a reason — every void carries one into the audit log', async () => {
    const charged = await chargeOnce('void-noreason');
    const res = await treq<{ error: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-noreason'),
      body: { transactionId: charged.transaction.id },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_required');
    // And it stayed voidable — a refusal is not a consumed opportunity.
    expect(
      scalar(`select count(*) from transaction where reverses_transaction_id='${charged.transaction.id}'`),
    ).toBe('0');
  });

  it('403s for a scanner principal without perms.void, and moves no money', async () => {
    const charged = await chargeOnce('void-noperms');
    const before = balanceOf(B_MEMBER);

    const res = await treq<{ error: string; message: string }>('POST', '/voids', {
      token: restricted,
      idempotencyKey: key('void-noperms'),
      body: { transactionId: charged.transaction.id, reason: 'ledger probe' },
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission to void a charge/i);
    expect(balanceOf(B_MEMBER), 'a refused void still credited the wallet').toBe(before);
  });

  /**
   * OUTSIDE THE WINDOW.
   *
   * The charge is backdated in the database rather than waited out, for the
   * obvious reason. That is honest here in a way it would not be everywhere: the
   * handler's own test is `now() - created_at > 15 minutes`, so moving
   * `created_at` exercises exactly the comparison the product makes, and the
   * alternative is a suite that takes a quarter of an hour.
   *
   * `transaction` carries no immutability trigger — unlike `ledger_entry` and
   * `audit_log`, which is why this technique is confined to this one table and
   * the money rows it points at are left alone.
   */
  it('outside the fifteen-minute window it is refused, and the merchant reimburses instead', async () => {
    const charged = await chargeOnce('void-outside');
    const before = balanceOf(B_MEMBER);

    psql(
      `UPDATE transaction SET created_at = now() - interval '${VOID_WINDOW_MINUTES + 1} minutes' ` +
        `WHERE id='${charged.transaction.id}';`,
    );

    const res = await treq<{ error: string; message: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-outside'),
      body: { transactionId: charged.transaction.id, reason: 'too late' },
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('void_window_closed');
    expect(res.body.message).toMatch(/Reimburse the customer instead/i);

    // Nothing moved, and no reversal row appeared.
    expect(balanceOf(B_MEMBER)).toBe(before);
    expect(
      scalar(`select count(*) from transaction where reverses_transaction_id='${charged.transaction.id}'`),
    ).toBe('0');
  });

  it('and one second INSIDE the window still succeeds — the boundary is the window, not a broken route', async () => {
    // The control for the spec above. Without it, a void endpoint that refused
    // everything would pass the window test perfectly.
    const charged = await chargeOnce('void-boundary');
    psql(
      `UPDATE transaction SET created_at = now() - interval '${VOID_WINDOW_MINUTES - 1} minutes' ` +
        `WHERE id='${charged.transaction.id}';`,
    );

    const res = await treq<{ ok: boolean }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-boundary'),
      body: { transactionId: charged.transaction.id, reason: 'just in time' },
    });
    expect(res.status, res.raw).toBe(200);
  });

  it('a charge cannot be voided twice — the money is safe whatever the answer is', async () => {
    /**
     * THE MONEY HALF, ASSERTED SEPARATELY FROM THE STATUS CODE.
     *
     * `transaction.reverses_transaction_id` carries a unique index, so a second
     * void is refused by the DATABASE rather than by a handler's good intentions,
     * and it is refused even if two scanner taps arrive at the same instant. That
     * is the part that protects the customer and it holds today.
     *
     * What comes back is wrong, and it is reported separately below — see the gap
     * ledger, "double-void answers request_in_progress". Splitting the two means
     * the money guarantee stays green and locked in while the status code is
     * still a defect, instead of one red spec covering both.
     */
    const charged = await chargeOnce('void-twice');
    const first = await treq<{ ok: boolean }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-twice-1'),
      body: { transactionId: charged.transaction.id, reason: 'first' },
    });
    precondition(first.status === 200, `the first void failed: ${first.raw}`);

    const balanceAfterVoid = balanceOf(B_MEMBER);

    const second = await treq('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-twice-2'),
      body: { transactionId: charged.transaction.id, reason: 'second' },
    });

    expect(second.status, 'a charge was voided twice').not.toBe(200);
    expect(balanceOf(B_MEMBER), 'the second void credited the wallet again').toBe(balanceAfterVoid);
    expect(
      scalar(`select count(*) from transaction where reverses_transaction_id='${charged.transaction.id}'`),
      'two reversal rows exist for one charge',
    ).toBe('1');
  });

  it('an unknown transaction id is a 404, and a charge at another salon looks identical', async () => {
    const notThere = await treq<{ error: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-unknown'),
      body: { transactionId: 'TX-0000000', reason: 'probe' },
    });
    expect(notThere.status).toBe(404);
    expect(notThere.body.error).toBe('unknown_transaction');

    // A real charge, at salon A. Salon B must not be able to tell it apart from
    // one that does not exist — "no such charge" and "not yours" are the same
    // sentence, or the endpoint is a transaction-id oracle for other salons.
    const salonACharge = scalar(
      `select coalesce(id,'') from transaction where salon_id='${SALON_A}' and kind='charge' limit 1`,
    );
    precondition(salonACharge !== '', 'salon A has no charge to probe with');

    const foreign = await treq<{ error: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('void-foreign'),
      body: { transactionId: salonACharge, reason: 'probe' },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('unknown_transaction');
    expect(foreign.raw).toBe(notThere.raw);
  });
});

// ===========================================================================
// PROMOTED OUT OF THE GAP LEDGER — three of the seven, now built
// ===========================================================================

/**
 * These were `knownBug()`s in the ledger below. Lane A landed all three, the
 * helper flipped each to "this appears to be FIXED", and they are plain `it()`s
 * here so the behaviour stays locked in.
 *
 * They are moved OUT of the gap ledger rather than left in it with the wrapper
 * swapped, because a ledger of gaps that is mostly not gaps stops being read as
 * one. What is still owed is still down there, and it is now four things.
 */

// ------------------------------------------------------------------ 1 --
/**
 * MANUAL LOOKUP — the path for the customer whose phone is flat.
 *
 * The gap entry asserted only that the endpoint exists and is salon-scoped, and
 * left the other three controls as `it.todo`s reading "cannot be written until
 * the endpoint exists". It exists. They are written.
 *
 * THE CONTROLS ARE THE FEATURE, not hardening added around it. A staff-facing
 * search box with none of them is a customer-list export with a text field on
 * the front, and the audit row is not telemetry — design/AVO Staff Scanner.dc.html
 * promises the CUSTOMER that lookups are logged.
 *
 * The four figures below are written out as literals from
 * `api/src/services/memberSearch.ts` rather than imported from it. A spec that
 * imported `MEMBER_SEARCH_MAX_PER_WINDOW` would pass at any value the
 * implementation happened to hold, including 30000.
 */
const SEARCH_MIN_QUERY = 2;
const SEARCH_MAX_PER_WINDOW = 60;
const SEARCH_WINDOW_MINUTES = 5;
const LOOKUP_ACTION = 'Customer looked up';
/**
 * The second tier, and it counts BOTH directory reads. `memberSearch.ts`
 * § enforceDirectoryReadLimits: keyed on `audit_log.actor_id` alone, no session and
 * no device in the predicate, across searches AND resolves.
 *
 * STILL A LITERAL, AND NOW WITH A GUARD BESIDE IT. The reason not to import it is
 * unchanged: a spec that read the value from the implementation would pass at any
 * value the implementation held, including one that had been raised to make a test
 * go green. The reason that used to be uncomfortable is that a literal rots — and
 * both of these did, when the measured cost per customer moved the numbers from
 * 30/60 to 60/240.
 *
 * So the literals stay and ONE spec compares them against the API's own source,
 * read off disk the way the route census reads routes. A change to either constant
 * then fails a single spec that names the old value, the new value and where to
 * look, instead of five specs failing for reasons none of them mentions.
 */
const SEARCH_MAX_PER_HOUR = 240;

/**
 * Backdated directory-read rows for one staff member, under a session that is not
 * the caller's.
 *
 * WHY THE HISTORY IS INSERTED RATHER THAN SPENT. Making 60 real reads trips the
 * 30-per-5-minute BURST tier first, and both tiers answer 429 — so a spec built
 * that way cannot tell which one refused it, which is the only thing it is trying
 * to find out. These rows carry a foreign session id, so the burst tier's
 * `sessionId` filter sees none of them and only a ceiling keyed on the staff member
 * can. Takes the ACTION as a parameter because the allowance is shared: filling it
 * with `Customer opened` and then being refused a search is the cross-door case.
 *
 * `audit_log` forbids UPDATE, so rows are inserted already backdated rather than
 * inserted and moved; `created_at` carries a DEFAULT and not a trigger, so an
 * explicit value is honoured. They also cannot be deleted afterwards by anybody,
 * which is why each caller uses a staff row nothing else needs.
 */
function backdateDirectoryReads(
  actorId: string,
  action: string,
  count: number,
  minutesAgo: number,
  sessionId: string,
): void {
  psql(`
    INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role, kind,
                           action, detail, source, subject_type, subject_id, metadata,
                           created_at)
    SELECT '${SALON_B}', 'staff', '${actorId}', 'backdated by lane D', 'frontdesk', 'access',
           '${action}', 'backdated to test the rolling hour', 'scanner',
           'member_search', NULL,
           ('{"query":"backdated","results":0,"sessionId":"${sessionId}"}')::jsonb,
           now() - interval '${minutesAgo} minutes'
      FROM generate_series(1, ${count});
  `);
}

interface MemberSearchItem {
  id: string;
  salonId: string;
  name: string;
  phoneLast4: string;
  tier: string | null;
}

const search = (token: string, q: string) =>
  treq<{ items: MemberSearchItem[]; error?: string; message?: string }>(
    'GET',
    `/members?q=${encodeURIComponent(q)}`,
    { token },
  );

/**
 * How many lookups this session has been charged for, read from the LOG.
 *
 * Deliberately the same rows the limiter counts. If lane A ever adds a separate
 * counter table, the specs below start disagreeing with it, which is the whole
 * point — see "the counter is the log" at the end of this block.
 */
const lookupsLogged = (sessionId: string): number =>
  Number(
    scalar(
      `select count(*) from audit_log
        where action='${LOOKUP_ACTION}'
          and metadata ->> 'sessionId' = '${sessionId}'`,
    ),
  );

/**
 * The `sid` claim out of an access token.
 *
 * Reading the token rather than guessing at the newest audit row: the rate limit
 * is scoped per SESSION, so a spec about it has to be able to name the session it
 * is talking about. The claim is in the token the client already holds — this
 * decodes, it does not verify, and it asserts nothing about the signature.
 */
function sessionIdOf(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('that access token has no payload segment');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sid?: string;
  };
  if (!claims.sid) throw new Error('that access token carries no `sid` claim');
  return claims.sid;
}

/**
 * THE GUARD ON THE LITERALS ABOVE.
 *
 * Read off disk as text, the way `discoverGetRoutes` reads the route table — no
 * import, so this suite gains no runtime dependency on `api/` and cannot be made
 * to agree with the implementation by accident.
 *
 * The point is the failure message. Both of these constants have already moved
 * once: Lane A measured the real cost of serving one customer through the
 * lookup screen's debounce — 2 requests for a fluent typer, 5 for someone pausing
 * on each key — and found the old ceiling fired at twelve customers an hour, with a
 * customer standing at the counter. The mechanism it had had backwards is worth
 * keeping in mind here: `abort()` does not un-send. It stops the client waiting for
 * a reply that is already in flight; the server has handled it and written its
 * audit row, and the audit row IS the counter. Every request that leaves the tablet
 * costs budget whether or not anybody reads the answer.
 */
describe('the rate-limit constants this suite pins are the ones the API holds', () => {
  const source = (): string =>
    readFileSync(join(repoRoot, 'api', 'src', 'services', 'memberSearch.ts'), 'utf8');

  const declared = (name: string): number | null => {
    const m = new RegExp(`export const ${name}\\s*=\\s*(\\d[\\d_]*)`).exec(source());
    return m ? Number(m[1]!.replace(/_/g, '')) : null;
  };

  for (const [name, pinned, what] of [
    ['MEMBER_SEARCH_MAX_PER_WINDOW', SEARCH_MAX_PER_WINDOW, 'the burst tier, per session'],
    ['MEMBER_SEARCH_ACTOR_MAX_PER_WINDOW', SEARCH_MAX_PER_HOUR, 'the ceiling, per staff member'],
  ] as const) {
    it(`${name} is still ${pinned} — ${what}`, () => {
      const actual = declared(name);
      expect(
        actual,
        `${name} is not declared in api/src/services/memberSearch.ts under that name any more, ` +
          'so this guard cannot see it and the literals in this file are unverified.',
      ).not.toBeNull();
      expect(
        actual,
        `${name} is now ${actual} and this suite pins ${pinned}. Every spec in this file that ` +
          'spends a budget uses the literal, so they are all wrong until it is updated — and ' +
          'they will each fail with a message about lookups rather than about a changed ' +
          'constant, which is why this spec exists. Update the literal at the top of this file, ' +
          'then re-read the heavy specs: raising a limit makes them slower and lowering one makes ' +
          'them share a budget they used to own.',
      ).toBe(pinned);
    });
  }
});

describe('GET /members?q= — the manual lookup, and the four controls that keep it one', () => {
  it('finds a customer by name', async () => {
    const res = await search(scanner, 'Fatima');

    expect(res.status, `GET /members?q= answered ${res.status} ${res.raw}`).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.map((m) => m.id)).toContain(B_MEMBER);
  });

  it('and by the digits of her number, however the number was stored', async () => {
    // The staff member reads four digits off a loyalty card; she does not know
    // whether the row holds `+96599555001` or `0099655...`.
    const last4 = B_MEMBER_PHONE.slice(-4);
    const res = await search(scanner, last4);

    expect(res.status, res.raw).toBe(200);
    expect(res.body.items.map((m) => m.id)).toContain(B_MEMBER);
  });

  it('SALON SCOPED — salon A\'s customers are not in salon B\'s search results', async () => {
    // Dana, salon A. Without the scope one salon's front desk searches every
    // customer AVO has, which is the tenancy boundary this suite has already
    // watched leak once.
    const res = await search(scanner, 'Dana');

    expect(res.status, res.raw).toBe(200);
    expect(res.body.items.map((m) => m.id)).not.toContain(A_MEMBER);
    expect(
      res.body.items.every((m) => m.salonId === SALON_B),
      `a foreign salon's customer came back: ${res.raw}`,
    ).toBe(true);
  });

  /**
   * THE SAME BOUNDARY, BOTH WAYS, AGAINST ONE NAME THAT EXISTS IN BOTH SALONS.
   *
   * The spec above is real but it is weaker than it reads, in two ways that only
   * show up together. It searches `Dana`, and the seeded names are DISTINCT —
   * `Dana Al-Sabah` in salon A, `Fatima Al-Rashed` in salon B — so it would pass
   * just as well against an API with no salon predicate at all, purely because no
   * salon B customer happens to be called Dana. And it only ever looks in one
   * direction, so an implementation that scoped salon B's reads and not salon A's
   * would satisfy it completely.
   *
   * A LEAK HAS TO BE UNMISTAKABLE FOR A SPEC TO BE WORTH ANYTHING, so this seeds
   * the same name in both salons and asserts each front desk sees exactly its own
   * one. If the predicate is missing, both searches return two rows — there is no
   * arrangement of the data that makes this pass by accident. And it is asserted
   * from BOTH sides, because "a scanner reading another salon's customer" is a bug
   * this project has already shipped, and it shipped in one direction.
   */
  describe('and it is scoped in BOTH directions, against a name both salons share', () => {
    const SHARED_NAME = 'Noura Al-Duplicate';
    const TWIN_IN_A = 'QA-TWIN-A1';
    const TWIN_IN_B = 'QA-TWIN-B1';
    let salonAScanner = '';

    beforeAll(async () => {
      for (const [id, salonId, phone] of [
        [TWIN_IN_A, SALON_A, '+96599777501'],
        [TWIN_IN_B, SALON_B, '+96599777502'],
      ] as const) {
        psql(`
          INSERT INTO member (id, salon_id, name, phone, email, email_verified,
                              password_hash, balance_fils, visits, tier, stamps, policy_version)
          SELECT '${id}', '${salonId}', '${SHARED_NAME}', '${phone}', NULL, false,
                 s.password_hash, 0, 0, 'bronze', NULL, 3
          FROM staff_user s WHERE s.id = '${B_STAFF}'
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, salon_id = EXCLUDED.salon_id;
        `);
      }
      // Salon A's own front desk, on salon A's own seeded device.
      salonAScanner = await signInScanner(SALON_A, 'noura', 'DEV-SCANNER-01');
    }, 60_000);

    it('salon B\'s front desk finds only salon B\'s twin', async () => {
      const res = await search(scanner, SHARED_NAME);
      expect(res.status, res.raw).toBe(200);

      const ids = res.body.items.map((m) => m.id);
      expect(ids, 'salon B cannot find its own customer by name').toContain(TWIN_IN_B);
      expect(
        ids,
        `salon B's search returned salon A's customer of the same name. Both salons have a ` +
          `"${SHARED_NAME}", so this is the salon predicate missing rather than a lucky name.`,
      ).not.toContain(TWIN_IN_A);
    });

    it('and salon A\'s front desk finds only salon A\'s — the direction nothing tested', async () => {
      const res = await search(salonAScanner, SHARED_NAME);
      expect(res.status, res.raw).toBe(200);

      const ids = res.body.items.map((m) => m.id);
      expect(ids, 'salon A cannot find its own customer by name').toContain(TWIN_IN_A);
      expect(
        ids,
        'salon A\'s search returned salon B\'s customer of the same name. Scoping one salon\'s ' +
          'reads and not the other\'s satisfies every spec that only ever looks one way.',
      ).not.toContain(TWIN_IN_B);
      expect(
        res.body.items.every((m) => m.salonId === SALON_A),
        `a foreign salon's customer came back to salon A: ${res.raw}`,
      ).toBe(true);
    });
  });

  it('returns what disambiguates a person and nothing more — no balance, no whole number', async () => {
    const res = await search(scanner, 'Fatima');
    precondition(res.status === 200, res.raw);
    const hit = res.body.items.find((m) => m.id === B_MEMBER);
    precondition(hit !== undefined, 'salon B\'s own customer is not in her own salon\'s results');

    // Last four digits only. The list is a picker, and a full contact number is
    // not what picking needs.
    expect(hit!.phoneLast4).toBe(B_MEMBER_PHONE.slice(-4));
    expect(hit!.phoneLast4.length).toBe(4);
    // A balance in a list is a balance readable over a shoulder for every
    // customer whose name shares a prefix.
    expect(hit!).not.toHaveProperty('balanceFils');
    expect(hit!).not.toHaveProperty('email');
    expect(res.raw).not.toContain(B_MEMBER_PHONE);
  });

  it(`MINIMUM LENGTH — a ${SEARCH_MIN_QUERY - 1}-character query is refused, because it returns the salon`, async () => {
    const res = await search(scanner, 'F');

    expect(res.status, `a one-character query answered ${res.status} ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('query_too_short');
    expect(res.body).not.toHaveProperty('items');
  });

  it('and an empty or whitespace query is the same refusal, not an unfiltered list', async () => {
    for (const q of ['', '   ']) {
      const res = await search(scanner, q);
      expect(res.status, `q=${JSON.stringify(q)} answered ${res.status} ${res.raw}`).toBe(400);
      expect(res.body.error).toBe('query_too_short');
    }
  });

  it('a LIKE metacharacter is a literal, not a wildcard — `%%` matches nobody', async () => {
    /**
     * THE HOLE THE LENGTH LIMIT DOES NOT COVER, which is why it is asserted
     * separately from it.
     *
     * `%%` is two characters, so it clears the minimum. Interpolated into a LIKE
     * pattern unescaped it becomes `%%%%` and matches every member in the salon —
     * the exact customer-list export the minimum was meant to prevent, reached by
     * a query that satisfies it. `_` is the same hole one character wide.
     */
    for (const q of ['%%', '%_', '__']) {
      const res = await search(scanner, q);
      expect(res.status, `q=${q} answered ${res.status} ${res.raw}`).toBe(200);
      expect(
        res.body.items,
        `q=${q} was treated as a wildcard and returned the salon's customer book: ${res.raw}`,
      ).toEqual([]);
    }
  });

  it('AUDIT ROW — one per lookup, naming the staff member and what she searched for', async () => {
    // A session of its own, so the count is this spec's and not whatever ran
    // before it in this file.
    const token = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
    const sid = sessionIdOf(token);
    precondition(lookupsLogged(sid) === 0, 'a brand-new session already has lookups against it');

    const res = await search(token, 'Fatima');
    precondition(res.status === 200, res.raw);

    expect(lookupsLogged(sid), 'the lookup was served and never logged').toBe(1);

    const row = scalar(
      `select kind || '|' || actor_id || '|' || source || '|' || subject_type
              || '|' || (metadata ->> 'query')
         from audit_log
        where action='${LOOKUP_ACTION}' and metadata ->> 'sessionId' = '${sid}'`,
    );
    expect(row).toBe(`access|${B_STAFF}|scanner|member_search|Fatima`);
  });

  it('logs a lookup that found nobody too — "who did she search for" is the question', async () => {
    const token = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
    const sid = sessionIdOf(token);

    const res = await search(token, 'Zzzznobody');
    precondition(res.status === 200, res.raw);
    expect(res.body.items).toEqual([]);

    expect(lookupsLogged(sid), 'a search that matched nothing was not logged').toBe(1);
  });

  it('records the QUERY and the result COUNT, never the customers who matched', async () => {
    // The alternative builds a second customer list inside an append-only,
    // seven-year log — every name a staff member ever searched, alongside every
    // member id it resolved to.
    const token = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
    const sid = sessionIdOf(token);

    const res = await search(token, 'Fatima');
    precondition(res.status === 200 && res.body.items.length > 0, res.raw);

    const metadata = scalar(
      `select metadata::text from audit_log
        where action='${LOOKUP_ACTION}' and metadata ->> 'sessionId' = '${sid}'`,
    );
    expect(JSON.parse(metadata).results).toBe(res.body.items.length);
    expect(
      metadata,
      `the matched customers were copied into the audit log: ${metadata}`,
    ).not.toContain(B_MEMBER);
  });

  it(`RATE LIMITED — ${SEARCH_MAX_PER_WINDOW} lookups per ${SEARCH_WINDOW_MINUTES} minutes per session, and the ${SEARCH_MAX_PER_WINDOW + 1}st is refused`, async () => {
    /**
     * ITS OWN SESSION, AND THAT IS WHAT MAKES THIS RE-RUNNABLE.
     *
     * The budget is per session and `audit_log` is append-only, so a run cannot
     * clear the rows it wrote. Burning the shared `scanner` session's budget would
     * therefore 429 every later lookup in this file for five minutes, and a second
     * run inside the window would start already throttled. A session minted here
     * begins at zero every time, whatever the previous run left behind — the same
     * property that stops a stolen token inheriting a staff member's leftovers.
     */
    /**
     * ITS OWN STAFF ROW AS WELL AS ITS OWN SESSION, and the second half is newer.
     *
     * A fresh session was enough while the only limit was per session. It is not
     * enough now: the ceiling counts 60 an hour PER STAFF MEMBER across every
     * session, so spending 30 here under the shared `scanner` row left barely
     * enough for the rest of the file — measured, before the merge, as "THE COUNTER
     * IS THE LOG" failing on its 19th lookup. `audit_log` cannot be trimmed, so the
     * budget cannot be given back; it can only be spent somewhere nobody else needs.
     */
    resetPinState(B_STAFF_BURST, B_BURST_DEVICE);
    const token = await signInScanner(SALON_B, B_STAFF_BURST_HANDLE, B_BURST_DEVICE);
    const sid = sessionIdOf(token);
    precondition(lookupsLogged(sid) === 0, 'a brand-new session already has lookups against it');

    for (let i = 0; i < SEARCH_MAX_PER_WINDOW; i += 1) {
      const res = await search(token, `probe${i}`);
      expect(res.status, `lookup ${i + 1} of ${SEARCH_MAX_PER_WINDOW} answered ${res.raw}`).toBe(200);
    }

    const refused = await search(token, 'Fatima');
    expect(
      refused.status,
      `lookup ${SEARCH_MAX_PER_WINDOW + 1} answered ${refused.status} ${refused.raw}`,
    ).toBe(429);
    expect(refused.body.error).toBe('lookup_rate_limited');
    // Nothing came back with the refusal — a throttled caller reads no customers.
    expect(refused.body).not.toHaveProperty('items');

    // And the refusal did not inflate the count it is judged on, or a client
    // retrying in a loop would extend its own lockout indefinitely.
    expect(
      lookupsLogged(sid),
      'the throttled lookup wrote an audit row, so a retry loop lengthens its own punishment',
    ).toBe(SEARCH_MAX_PER_WINDOW);

    // Per SESSION, asserted rather than assumed: the shared session is untouched
    // and can still search. Without this the spec above is equally consistent with
    // a global limit that has just taken the whole salon offline.
    const other = await search(scanner, 'Fatima');
    expect(
      other.status,
      `one session's exhausted budget refused another session: ${other.raw}`,
    ).toBe(200);
  }, 60_000);

  it('THE COUNTER IS THE LOG — a row appended by hand consumes budget', async () => {
    /**
     * WHY THIS IS WORTH A SPEC OF ITS OWN.
     *
     * Lane A made the audit log itself the rate-limit counter, on the grounds
     * that the limit must count the thing the promise is about. That is a real
     * design decision with a real consequence — the two can never drift, so "how
     * many times did she search today" has exactly one answer — and it is the
     * kind of decision a later refactor undoes by adding a tidy `lookup_counter`
     * table without noticing what it cost.
     *
     * This is the assertion that notices, and it is written the way it is because
     * the obvious version is impossible. Deleting the rows and watching the budget
     * return would be the cleaner demonstration; `audit_log` refuses a DELETE from
     * EVERYONE, the database owner included — see the note on the paired spec
     * below. So the experiment runs the other way: a session is taken to one
     * lookup short of its limit, ONE row is appended by hand, and the next real
     * lookup is refused.
     *
     * That is only explicable if the injected row was counted. The spec above
     * establishes the control — thirty real lookups succeed and the thirty-first
     * does not — so twenty-nine real plus one appended cannot be an off-by-one.
     * Against a separate counter table the injected row changes nothing and the
     * thirtieth lookup is served.
     *
     * ITS OWN STAFF ROW, for the reason the burst spec above now carries in full:
     * this is the spec that actually failed when the per-staff hourly ceiling
     * arrived, on its 19th lookup, because the shared row had already been spent.
     * The injected row below is written under THIS session's id, so it consumes
     * this staff member's budget and nobody else's.
     */
    resetPinState(B_STAFF_COUNTER, B_COUNTER_DEVICE);
    const token = await signInScanner(SALON_B, B_STAFF_COUNTER_HANDLE, B_COUNTER_DEVICE);
    const sid = sessionIdOf(token);
    precondition(lookupsLogged(sid) === 0, 'a brand-new session already has lookups against it');

    for (let i = 0; i < SEARCH_MAX_PER_WINDOW - 1; i += 1) {
      const res = await search(token, `count${i}`);
      precondition(res.status === 200, `lookup ${i + 1} answered ${res.raw}`);
    }
    precondition(
      lookupsLogged(sid) === SEARCH_MAX_PER_WINDOW - 1,
      `the log holds ${lookupsLogged(sid)} rows after ${SEARCH_MAX_PER_WINDOW - 1} lookups`,
    );

    // One row, appended. Same action, same session, nothing else touched.
    psql(`
      INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role, kind,
                             action, detail, source, subject_type, subject_id, metadata)
      VALUES ('${SALON_B}', 'staff', '${B_STAFF_COUNTER}', 'Budget Counter', 'frontdesk', 'access',
              '${LOOKUP_ACTION}', 'appended by lane D to prove the counter is this table',
              'scanner', 'member_search', NULL,
              '{"query":"injected","results":0,"sessionId":"${sid}"}'::jsonb);
    `);
    precondition(lookupsLogged(sid) === SEARCH_MAX_PER_WINDOW, 'the appended row is not in the log');

    const next = await search(token, 'Fatima');
    expect(
      next.status,
      'appending a row to audit_log did not consume any budget, so the limiter is counting ' +
        `something other than the log it is supposed to be counting: ${next.raw}`,
    ).toBe(429);
    expect(next.body.error).toBe('lookup_rate_limited');
  }, 60_000);

  it('and nobody can trim it — audit_log refuses a DELETE from the app role AND from its owner', async () => {
    /**
     * THE PROPERTY THAT MAKES THE COUPLING ABOVE SAFE, and it is stronger than
     * the comment in `api/src/services/memberSearch.ts` claims. That file rests
     * the argument on "the application role cannot UPDATE or DELETE it", which is
     * true and is only half of it: there is also a trigger, so the refusal does
     * not depend on which role happens to be connected.
     *
     * Both halves are asserted, because they fail differently and a reader should
     * be able to tell which one is holding. As `avo_app` the grant check fires
     * first — "permission denied". As the OWNER the grants allow it and the
     * trigger refuses instead. Lane D found the second half by trying to delete
     * its own rows as `avo`, which is the only way anyone finds out.
     *
     * `SET ROLE` rather than a second connection: the privilege check then runs
     * as `avo_app` on a connection `psql()` already has, and what comes back is
     * Postgres refusing rather than a test asserting that a grant table looks
     * right.
     */
    const attempt = (statement: string): string => {
      try {
        psql(`SET ROLE avo_app; ${statement}`);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };

    const deleted = attempt(`DELETE FROM audit_log WHERE action='${LOOKUP_ACTION}';`);
    expect(deleted, 'the application role can DELETE from audit_log').toMatch(/permission denied/i);

    const updated = attempt(`UPDATE audit_log SET action='edited' WHERE action='${LOOKUP_ACTION}';`);
    expect(updated, 'the application role can UPDATE audit_log').toMatch(/permission denied/i);

    // The owner, with every grant, refused by the trigger instead.
    const asOwner = (statement: string): string => {
      try {
        psql(statement);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    expect(
      asOwner(`DELETE FROM audit_log WHERE action='${LOOKUP_ACTION}';`),
      'the database OWNER can delete audit rows, so append-only is a grant and not a rule',
    ).toMatch(/append-only/i);
    expect(
      asOwner(`UPDATE audit_log SET action='edited' WHERE action='${LOOKUP_ACTION}';`),
      'the database OWNER can edit audit rows',
    ).toMatch(/append-only/i);
  });

  it('the lookup needs perms.scanner — a principal who may not scan may not search instead', async () => {
    // Noor holds `scanner`, so she is the wrong probe here; the restricted
    // principal for THIS control is a dashboard session, which has no scanner
    // scope at all. A search box is the fallback for a scan, not a wider door.
    const web = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    const res = await search(web, 'Fatima');

    expect(res.status, `a dashboard session searched customers: ${res.raw}`).toBe(403);
    expect(res.raw).not.toContain('Fatima Al-Rashed');
  });

  /**
   * THE OTHER HALF OF THAT CONTROL, and the comment above says why it was missing:
   * every seeded salon B scanner principal HOLDS `scanner`, so there was nobody to
   * probe with. A dashboard session proves the SURFACE gate, not the PERMISSION
   * gate, and `requirePerm` runs the two in that order — a spec that only ever
   * sees the first refusal cannot tell whether the second is wired up at all.
   *
   * So the permission is taken from a principal who is otherwise entirely correct:
   * right salon, right device, a live scanner session she signed in for herself.
   * And it is taken AFTER she signs in, which makes this two specs in one —
   * auth/principal.ts states that permissions are read from `staff_user` on EVERY
   * request and never from a claim inside the token, precisely so that "a manager
   * who revokes `charges` at 14:00 expects it gone at 14:00, not whenever a
   * fifteen-minute token happens to expire". Were the perms baked into the JWT at
   * sign-in, this call would still succeed.
   */
  it('and a LIVE scanner session whose perms.scanner is revoked mid-session is refused on its next request', async () => {
    resetPinState(B_STAFF_RESTRICTED, B_RESTRICTED_DEVICE);
    const noor = await signInScanner(SALON_B, B_STAFF_RESTRICTED_HANDLE, B_RESTRICTED_DEVICE);

    // She can search right now, which is what makes the refusal below attributable
    // to the permission and not to her credential, her device or her salon.
    const before = await search(noor, 'Fatima');
    precondition(
      before.status === 200,
      `${B_STAFF_RESTRICTED_HANDLE} could not search BEFORE the permission was revoked: ` +
        `${before.status} ${before.raw}`,
    );

    try {
      psql(`UPDATE staff_user SET perm_scanner = false WHERE id = '${B_STAFF_RESTRICTED}';`);

      const res = await search(noor, 'Fatima');
      expect(
        res.status,
        'a staff member whose perms.scanner was revoked can still search customers by name. The ' +
          'search box is the fallback for a scan she may no longer perform, so this is the ' +
          'scanner permission with a text field around it.\n' + res.raw,
      ).toBe(403);
      // The design's own copy for a permission she does not hold.
      expect(res.body.message, 'the 403 does not name the permission or who can grant it').toBe(
        "You don't have permission to scan and charge. A manager can grant it.",
      );
      // And the refusal is the whole response — no customer rows behind it.
      expect(res.raw, 'the refused search leaked a customer').not.toContain('Fatima Al-Rashed');
      expect(res.body).not.toHaveProperty('items');
    } finally {
      // Restored in a `finally` because later specs signing Noor in expect her
      // seeded authority back. A shared fixture left mutated by a spec is the
      // failure this suite has already been bitten by three times.
      psql(`UPDATE staff_user SET perm_scanner = true WHERE id = '${B_STAFF_RESTRICTED}';`);
    }
  });

  /**
   * A REFUSED LOOKUP MUST NOT BE CHARGED FOR, and this is not tidiness.
   *
   * The limiter counts `audit_log` rows. A refusal that wrote one would judge the
   * caller on requests that were never served — and worse for the hourly ceiling
   * lane A is adding, which is keyed on the STAFF MEMBER rather than the session:
   * a single throttled tab could then lock her out of the lookup for the rest of
   * the hour by being refused repeatedly. The 429 case is covered above; these are
   * the other two refusals.
   */
  it('a refused lookup writes no audit row — not the 400, and not the 403', async () => {
    resetPinState(B_STAFF_RESTRICTED, B_RESTRICTED_DEVICE);
    const fresh = await signInScanner(SALON_B, B_STAFF_RESTRICTED_HANDLE, B_RESTRICTED_DEVICE);
    const sid = sessionIdOf(fresh);
    precondition(lookupsLogged(sid) === 0, 'this session has already been charged for a lookup');

    // Too short — refused before the query is built at all.
    const short = await search(fresh, 'F');
    precondition(short.status === 400, `the short query answered ${short.status} ${short.raw}`);
    expect(
      lookupsLogged(sid),
      'a query refused for being too short was written to the log anyway, so it consumed rate ' +
        `limit budget. ${SEARCH_MIN_QUERY} characters is the minimum precisely because a shorter ` +
        'one is a directory walk, and charging for the refusal is what makes the walk cost the ' +
        'walker nothing.',
    ).toBe(0);

    // And the 403, which never reaches the service at all.
    const web = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    const webSid = sessionIdOf(web);
    const refused = await search(web, 'Fatima');
    precondition(refused.status === 403, `the dashboard search answered ${refused.status}`);
    expect(
      lookupsLogged(webSid),
      'a search refused for the wrong credential still wrote a lookup row. This log is the record ' +
        'shown to the CUSTOMER that her details were looked at — a row for a search that never ' +
        'ran says somebody saw her when nobody did.',
    ).toBe(0);
  });

  /**
   * THE LIMIT IS PER SESSION, PROVED FROM THE THROTTLED SIDE.
   *
   * The spec above exhausts one session and shows a DIFFERENT, pre-existing
   * session still working. That is the same property from the easy direction: the
   * other session was already live, so a limiter keyed on the staff member could
   * still have been counting only rows it had already seen. This does it the way a
   * real staff member does — she is refused, so she signs out and back in — which
   * is also the shape that must eventually STOP working when lane A's hourly
   * ceiling lands. Written down explicitly rather than left implied, because it is
   * the exact behaviour the next tier is designed to remove.
   */
  it('a NEW session for the same staff member is not born throttled', async () => {
    resetPinState(B_STAFF_RATELIMIT, B_RATELIMIT_DEVICE);
    const first = await signInScanner(SALON_B, B_STAFF_RATELIMIT_HANDLE, B_RATELIMIT_DEVICE);
    const firstSid = sessionIdOf(first);
    precondition(lookupsLogged(firstSid) === 0, 'that session has already spent budget');

    for (let i = 0; i < SEARCH_MAX_PER_WINDOW; i++) {
      const res = await search(first, 'Fatima');
      precondition(res.status === 200, `lookup ${i + 1} answered ${res.status} ${res.raw}`);
    }
    const throttled = await search(first, 'Fatima');
    precondition(
      throttled.status === 429,
      `the session was not throttled after ${SEARCH_MAX_PER_WINDOW}: ${throttled.status}`,
    );

    // Same staff member, same device, a brand-new session.
    resetPinState(B_STAFF_RATELIMIT, B_RATELIMIT_DEVICE);
    const second = await signInScanner(SALON_B, B_STAFF_RATELIMIT_HANDLE, B_RATELIMIT_DEVICE);
    expect(sessionIdOf(second), 'the sign-in returned the same session').not.toBe(firstSid);

    const afterReauth = await search(second, 'Fatima');
    expect(
      afterReauth.status,
      'a fresh session for the same staff member was refused, so the burst limiter is keyed on ' +
        'something wider than the session it claims to be keyed on.\n' + afterReauth.raw,
    ).toBe(200);

    // And the first session is still throttled: re-authenticating does not
    // rehabilitate the session that overspent.
    const stillThrottled = await search(first, 'Fatima');
    expect(
      stillThrottled.status,
      'signing in again cleared the throttle on the OLD session, so the limit can be reset at ' +
        'will and is therefore not a limit',
    ).toBe(429);
  }, 180_000);
});

// ----------------------------------------------------------------- 1b --
/**
 * TWO THINGS LANE A HAS BUILT ON `feat/api` THAT THIS BRANCH HAS NOT MERGED.
 *
 * Written as `knownBug()`, which is exactly what that helper is for: the assertion
 * is the one the contract calls for, it fails today, and it goes RED the hour the
 * merge lands, so the coverage promotes itself rather than waiting on somebody to
 * remember. LANES.md is explicit that lane D's worst runs came from testing one
 * lane's branch in isolation; a knownBug is how the assertion can exist on this
 * branch without the suite going red for code this branch does not have.
 *
 * NEITHER IS ALLOWED TO PASS FOR THE WRONG REASON, which took some care.
 *
 *   The id spec is trivially safe: one request, one assertion.
 *
 *   The hourly ceiling is NOT. The obvious construction spends sixty real
 *   lookups, and that trips the 30-per-5-minute BURST tier first — so the spec
 *   would see a 429 either way and `knownBug`, which accepts any assertion
 *   failure, would report green whether or not a ceiling existed. So the history
 *   is INSERTED as backdated rows carrying a different session id, and the spec
 *   makes exactly ONE real lookup. The burst tier filters on this session's id and
 *   sees one; only a ceiling keyed on the staff member alone can see sixty. That
 *   is what makes the two tiers distinguishable, and distinguishing them is the
 *   entire assertion.
 *
 * `audit_log` forbids UPDATE, so the rows are inserted already backdated rather
 * than inserted and moved. `created_at` carries a DEFAULT rather than a trigger,
 * so an explicit value is honoured.
 */
describe('GET /members?q= — the member id, and the ceiling that made the burst limit real', () => {
  /**
   * WHICH STAFF MEMBER EACH SPEC BACKDATES AGAINST, and it is not arbitrary.
   *
   * `audit_log` refuses DELETE from the owner as well as from the application, so
   * rows written here CANNOT BE CLEANED UP — they last the whole run. A ceiling
   * keyed on the staff member therefore means that whoever these rows name is
   * spent for the rest of the hour the moment the ceiling exists.
   *
   * So neither spec may name a staff member that other lookup specs search as.
   * `B_STAFF` is the wrong choice twice over: it is the shared `scanner` session's
   * staff row AND the 30-lookup burst spec's, so this file already spends most of
   * an hour's budget under that id — see the note in the lane report about that
   * collision, which is a merge hazard rather than a defect here.
   *
   * The lockout and rate-limit fixtures are the right probes: they exist to be
   * driven into refusals, and no lookup spec searches as either of them except
   * the ones that name them explicitly.
   */
  const CEILING_STAFF = B_STAFF_LOCKOUT;
  const CEILING_STAFF_HANDLE = B_STAFF_LOCKOUT_HANDLE;
  const CEILING_DEVICE = B_LOCKOUT_DEVICE;

  const EDGE_STAFF = B_STAFF_RATELIMIT;
  const EDGE_STAFF_HANDLE = B_STAFF_RATELIMIT_HANDLE;
  const EDGE_DEVICE = B_RATELIMIT_DEVICE;

  /**
   * A COLLISION THE MERGE WILL HIT, MEASURED RATHER THAN PREDICTED.
   *
   * Lane A's feat/api memberSearch.ts was checked out into this worktree and the
   * lookup block above was run against it. Result: "THE COUNTER IS THE LOG" fails
   * on its 19th lookup with
   *
   *     precondition failed: lookup 19 answered
   *     {"error":"lookup_hourly_limit","message":"This account has looked up too
   *      many customers in the last hour. It will free up shortly."}
   *
   * and it passes in isolation, so it is not a defect in either the spec or the
   * ceiling. It is ACCUMULATION: this file spends most of an hour's budget under
   * one staff id — `B_STAFF` is both the shared `scanner` session's row and the
   * 30-lookup burst spec's — and the new ceiling counts per staff member across
   * every session, which is precisely the property that makes it worth having.
   *
   * So on merge, the ceiling is working and the suite is what needs changing:
   * spread the lookup specs across staff rows, or give the heavy ones their own.
   * Recorded here rather than pre-emptively refactored, because these specs are
   * correct on this branch today and rewriting them against code this checkout
   * does not have is exactly the isolation trap LANES.md warns about.
   *
   * Worth a product question too, and it belongs to trunk: 60 an hour per staff
   * member is one lookup a minute, and a front desk working through a queue of
   * customers with flat phones is the case the endpoint exists for.
   */
  const MERGE_COLLISION = 'see the note above — measured against feat/api, not predicted';
  void MERGE_COLLISION;

  /**
   * PROMOTED from knownBug. Lane A's 540b3f1 merged, the assertion started passing,
   * and the helper failed the spec telling me to lock the behaviour in — which is
   * the whole point of writing it that way rather than waiting for the merge.
   *
   * THE MEMBER ID IS THE ONE QUERY THAT MUST NEVER FAIL. It is the number printed
   * on the customer's own card and the most precise identifier a staff member can
   * be holding, and it returned nothing: it has digits, so it fell through to the
   * phone branch, and the stored E.164 number does not contain it. The failure
   * renders as "she isn't a member here".
   */
  it('finds a customer by her MEMBER ID — the number printed on her own card', async () => {
    const res = await search(scanner, B_MEMBER);
    expect(res.status, `the id lookup answered ${res.status} ${res.raw}`).toBe(200);
    expect(
      res.body.items.map((m) => m.id),
      'the member id did not find the member it names',
    ).toContain(B_MEMBER);
  });

  /**
   * The other half of that fix, and it must keep passing AFTER the merge.
   *
   * Not a knownBug: a prefix returns nothing today because there is no id clause
   * at all, and it must still return nothing afterwards. Green on both sides of
   * the merge, which makes it the guard that the fix arrived as an equality rather
   * than as a `LIKE`.
   */
  it('a PREFIX of a member id matches nothing — exactness is the disclosure decision', async () => {
    for (const prefix of [B_MEMBER.slice(0, 3), B_MEMBER.slice(0, 2)]) {
      const res = await search(scanner, prefix);
      precondition(res.status === 200, `q=${prefix} answered ${res.status} ${res.raw}`);
      expect(
        res.body.items.map((m) => m.id),
        `q=${prefix} matched member ${B_MEMBER} by an id PREFIX. Ids are short, dense and ` +
          'sequential, so a prefix match over that column enumerates the salon\'s membership ' +
          `two characters at a time — which is what the ${SEARCH_MIN_QUERY}-character minimum ` +
          'exists to prevent. The id clause has to be an equality.',
      ).not.toContain(B_MEMBER);
    }
  });

  /**
   * PROMOTED from knownBug. Lane A's 3da4572 merged and this started passing.
   *
   * THE CEILING IS WHAT MAKES THE BURST LIMIT REAL. The spec above proves the
   * per-session tier is resettable by signing out and back in — a session was never
   * a scarce resource, so a limit keyed on one could always be refreshed. This tier
   * is keyed on `audit_log.actor_id` ALONE, with no session and no device in the
   * predicate, which is precisely the property the first tier lacked.
   *
   * AND IT STILL MUST NOT PASS FOR THE WRONG REASON. Spending 60 real lookups would
   * trip the 30-per-5-minute burst tier first and answer 429 either way, proving
   * nothing about which tier fired. So the history is INSERTED backdated under a
   * DIFFERENT session id and the spec makes exactly ONE real lookup: the burst tier
   * filters on this session and sees one, and only a ceiling keyed on the staff
   * member can see sixty. The assertion is on the error CODE, never on the status,
   * because both tiers answer 429 and the code is the only thing that distinguishes
   * them.
   */
  it(`refuses the ${SEARCH_MAX_PER_HOUR + 1}st lookup by one STAFF MEMBER in a rolling hour, whatever session it comes from`, async () => {
    resetPinState(CEILING_STAFF, CEILING_DEVICE);
    const fresh = await signInScanner(SALON_B, CEILING_STAFF_HANDLE, CEILING_DEVICE);
    const sid = sessionIdOf(fresh);
    precondition(lookupsLogged(sid) === 0, 'this session has already spent budget');

    backdateDirectoryReads(CEILING_STAFF, LOOKUP_ACTION, SEARCH_MAX_PER_HOUR, 30, 'not-this-session');

    const res = await search(fresh, 'Fatima');
    expect(
      res.body.error,
      `${SEARCH_MAX_PER_HOUR} lookups by this staff member within the last hour did not stop the ` +
        `next one. The burst tier cannot see them — they carry another session's id and this ` +
        `session has made ${lookupsLogged(sid)} — so only a ceiling keyed on the staff member ` +
        `alone can refuse this call. Answered ${res.status}: ${res.raw}`,
    ).toBe('lookup_hourly_limit');
    expect(res.status).toBe(429);
    // The refusal is the whole response: a throttled caller reads no customers.
    expect(res.body).not.toHaveProperty('items');
  }, 120_000);

  /**
   * THE WINDOW EDGE, green on both sides of the merge on purpose.
   *
   * The same history one minute OUTSIDE the rolling hour must refuse nobody.
   * Today it passes because there is no ceiling; afterwards it passes because the
   * ceiling is a ROLLING window and not a counter that never forgets. A ceiling
   * with no expiry would lock a busy front desk out permanently, which is worse
   * than the hole it closes — so this is the spec that stops the fix overshooting,
   * and it cannot be a knownBug because it has to hold in both states.
   */
  it('and an hour\'s worth of lookups OLDER than the hour refuse nobody', async () => {
    resetPinState(EDGE_STAFF, EDGE_DEVICE);
    const fresh = await signInScanner(SALON_B, EDGE_STAFF_HANDLE, EDGE_DEVICE);
    const sid = sessionIdOf(fresh);
    precondition(lookupsLogged(sid) === 0, 'this session has already spent budget');

    // 61 minutes: outside a 60-minute rolling window by one minute. Backdated
    // against a DIFFERENT staff member from the ceiling spec above, so the two
    // cannot contaminate each other whichever order they happen to run in.
    backdateDirectoryReads(EDGE_STAFF, LOOKUP_ACTION, SEARCH_MAX_PER_HOUR, 61, 'not-this-session');

    const res = await search(fresh, 'Fatima');
    expect(
      res.status,
      `lookups older than the rolling hour still counted against it (${res.raw}). A ceiling that ` +
        'never forgets is not a rate limit, it is a lifetime quota — and the front desk that hits ' +
        'it on a busy Thursday could never look a customer up again.',
    ).toBe(200);
  }, 120_000);
});

// ------------------------------------------------------------------ 2 --
describe('GET /charges marks a voided charge, so the scanner stops offering to void it again', () => {
  /**
   * The money was always safe — the unique index on `reverses_transaction_id`
   * makes a second void impossible and the spec above proves it. What was wrong
   * was the SCREEN: an already-voided charge rendered identically to a live one
   * and still offered "Void this charge", so the staff member pressed it in front
   * of the customer and got an error for doing what she was invited to do.
   *
   * Lane A resolved it with a self-join onto the reversal rather than a second
   * query, so the marker cannot disagree with the row it is attached to.
   */
  it('carries voidedAt and reversedByTransactionId once the charge is reversed', async () => {
    const charged = await chargeOnce('voided-flag');
    const voided = await treq<{ ok: boolean }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('voided-flag'),
      body: { transactionId: charged.transaction.id, reason: 'to mark it voided' },
    });
    precondition(voided.status === 200, `the void failed: ${voided.raw}`);

    /**
     * The reversal's id comes from the ROW, because `POST /voids` does not return
     * it — the response is `{ ok, refundedFils, visitRemoved }`. Worth stating,
     * because the natural way to write this spec is to read it off that response,
     * and doing so would compare the list against nothing.
     */
    const reversalId = scalar(
      `select id from transaction where reverses_transaction_id='${charged.transaction.id}'`,
    );
    precondition(reversalId !== '', 'the void wrote no reversal row');

    const res = await treq<{ items: Array<Record<string, unknown>> }>('GET', '/charges', {
      token: scanner,
    });
    precondition(res.status === 200, `GET /charges answered ${res.status}`);
    const row = res.body.items.find((t) => t.id === charged.transaction.id);
    precondition(row !== undefined, 'the voided charge left the list entirely');

    expect(
      typeof row!.voidedAt,
      `the voided charge is indistinguishable from a live one: ${JSON.stringify(row)}`,
    ).toBe('string');
    expect(Number.isFinite(Date.parse(row!.voidedAt as string))).toBe(true);
    // Not merely a boolean: the marker names the reversal, so the screen can link
    // to the row that returned the money rather than only greying a button out.
    expect(row!.reversedByTransactionId).toBe(reversalId);
  });

  it('and a charge that has NOT been voided carries neither — the marker is a fact, not a column that is always set', async () => {
    // The control. Without it the spec above passes against a serialiser that
    // stamps every row with the same timestamp.
    const charged = await chargeOnce('not-voided-flag');
    const res = await treq<{ items: Array<Record<string, unknown>> }>('GET', '/charges', {
      token: scanner,
    });
    const row = res.body.items.find((t) => t.id === charged.transaction.id);
    precondition(row !== undefined, 'the charge just made is not in the list');

    expect(row!.voidedAt ?? null).toBeNull();
    expect(row!.reversedByTransactionId ?? null).toBeNull();
  });
});

// ------------------------------------------------------------------ 3 --
// ===========================================================================
// CONCURRENCY ON THE CHARGE PATH — ported from the mock, where it proved nothing
// ===========================================================================

describe('two charges at once — the races the mock could not run', () => {
  /**
   * PORTED FROM concurrency.test.ts, WHERE IT COULD NOT MEAN ANYTHING.
   *
   * That file runs against `packages/mock` — an in-memory `Map` in a single Node
   * process — and its own comment says so in terms: "the mock wins this by
   * accident. Its check-and-delete on the token map is synchronous inside one
   * handler in one process, so the two requests cannot interleave... Passing here
   * is not evidence that the real one is safe."
   *
   * It was right, and it stayed on the mock. So the guarantee that a wallet token
   * is single-use UNDER A REAL RACE — two connections, two transactions, one row —
   * has never actually been tested. This is that test.
   */
  it('racing — two charges on ONE wallet token, concurrently: exactly one settles', async () => {
    const token = await freshWalletToken();
    const before = balanceOf(B_MEMBER);
    const visitsBefore = visitsOf(B_MEMBER);

    // DIFFERENT idempotency keys, so the key is not what resolves this. The only
    // thing standing between two simultaneous debits is the token's own
    // single-use consumption inside the charge transaction.
    const [a, b] = await Promise.all([
      treq<any>('POST', '/charges', {
        token: scanner,
        idempotencyKey: key('token-race-a'),
        body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
      }),
      treq<any>('POST', '/charges', {
        token: scanner,
        idempotencyKey: key('token-race-b'),
        body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
      }),
    ]);

    expect(
      [a.status, b.status].sort(),
      `the racing charges answered: ${a.raw} / ${b.raw}`,
    ).toEqual([200, 410]);

    const loser = [a, b].find((r) => r.status === 410)!;
    expect(loser.body.error).toBe('token_consumed_or_unknown');

    /**
     * ONE DEBIT. This is the assertion the mock could not make honestly: a
     * check-then-act on a Map cannot interleave, but two Postgres transactions
     * can, and only a conditional consumption inside the debit's own transaction
     * makes this hold.
     */
    expect(
      balanceOf(B_MEMBER),
      'both racing charges debited her, so one QR paid for two visits',
    ).toBe(before - B_SERVICE_PRICE_FILS);
    // And the whole rest of the charge went with it, exactly once.
    expect(visitsOf(B_MEMBER), 'the losing charge still counted a visit').toBe(visitsBefore + 1);
    expect(
      Number(
        scalar(
          `select count(*) from transaction where member_id='${B_MEMBER}' and kind='charge'
             and reference in ('${a.body?.transaction?.reference ?? ''}',
                               '${b.body?.transaction?.reference ?? ''}')`,
        ),
      ),
      'two charge rows exist for one token',
    ).toBe(1);
  }, 60_000);

  /**
   * THE OTHER HALF, ALSO PORTED, AND ALSO PREVIOUSLY UNTESTABLE.
   *
   * `scanner.test.ts` already proves a SEQUENTIAL replay under one key returns the
   * first result verbatim. That is the easy half: the second request arrives after
   * the first has committed, so it reads a finished key row. The hard half is two
   * requests under one key IN FLIGHT AT ONCE, where neither can see the other's
   * uncommitted row — which is what non-negotiable #4 has to survive, because a
   * double-tap on a salon tablet is exactly two requests at once.
   *
   * The mock's version of this could not fail: one process, one Map, no overlap.
   */
  it('racing — two charges under ONE idempotency key: one settles, one debit', async () => {
    const token = await freshWalletToken();
    const idem = key('key-race');
    const before = balanceOf(B_MEMBER);

    const [a, b] = await Promise.all([
      treq<any>('POST', '/charges', {
        token: scanner,
        idempotencyKey: idem,
        body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
      }),
      treq<any>('POST', '/charges', {
        token: scanner,
        idempotencyKey: idem,
        body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
      }),
    ]);

    /**
     * The loser may legitimately be a 200 replay OR a 409 `request_in_progress`,
     * and both are correct: the key row is claimed inside the transaction, so a
     * simultaneous second attempt either waits and replays or is told the first is
     * still running. What is NOT acceptable is two debits, so the assertion is on
     * the MONEY and on the statuses being drawn from that set — not on which one
     * happened to win.
     */
    for (const r of [a, b]) {
      expect(
        [200, 409].includes(r.status),
        `a racing same-key charge answered ${r.status}, which is neither a replay nor a ` +
          `refusal: ${r.raw}`,
      ).toBe(true);
    }
    expect([a, b].filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);

    expect(
      balanceOf(B_MEMBER),
      'two charges under ONE idempotency key both debited her. A double-tap on the tablet is two ' +
        'requests at once, and this is the guarantee non-negotiable #4 exists to make.',
    ).toBe(before - B_SERVICE_PRICE_FILS);
  }, 60_000);

  /**
   * FIVE, NOT TWO — and this is the case `STATUS.md` claims is proven.
   *
   * "five concurrent charges on one token" is listed under What works. It was
   * tested two-at-a-time, against the mock. Two is enough to find a check-then-act
   * hole; five is what finds the one that only opens when a third connection
   * arrives while two are already waiting on the same row lock.
   */
  it('and five at once on one token still settle exactly one', async () => {
    const token = await freshWalletToken();
    const before = balanceOf(B_MEMBER);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        treq<any>('POST', '/charges', {
          token: scanner,
          idempotencyKey: key(`five-race-${i}`),
          body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
        }),
      ),
    );

    const settled = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 410);
    expect(
      settled.length,
      `five concurrent charges settled ${settled.length} of them: ` +
        results.map((r) => r.status).join(', '),
    ).toBe(1);
    expect(refused.length, 'a loser answered something other than 410 Gone').toBe(4);
    for (const r of refused) expect(r.body.error).toBe('token_consumed_or_unknown');

    expect(
      balanceOf(B_MEMBER),
      'five charges on one QR moved more than one visit of money',
    ).toBe(before - B_SERVICE_PRICE_FILS);
  }, 60_000);
});

describe('a double void says already_voided, not request_in_progress', () => {
  /**
   * WHAT IT USED TO ANSWER, AND WHY THAT WAS WORSE THAN A WRONG STATUS CODE.
   *
   * The second void hit the unique index on `reverses_transaction_id`;
   * `withIdempotency` caught the unique violation, assumed it must have been the
   * IDEMPOTENCY key that collided, looked for the winner's stored response under
   * a key that had never existed, found nothing, and answered
   * `409 request_in_progress`. The scanner then told the staff member "that
   * request is still being processed, try again in a moment" — advice that is
   * wrong, that invites a third attempt, and that hides the true state, which is
   * that the customer already has her money back.
   *
   * Lane A fixed it in BOTH places it arises, and the two are genuinely
   * different, which is why there are two specs here rather than one:
   *
   *   - the SEQUENTIAL case, where the first void has already committed. A read
   *     inside the money transaction finds the existing reversal and refuses
   *     before anything is written.
   *   - the RACE, where two voids are in flight and neither has committed, so
   *     there is nothing to read. That one can only be resolved by the database,
   *     and `violatedConstraint()` is what tells the two unique indexes apart
   *     after the fact.
   *
   * A fix that only handled the first would pass a sequential spec and still
   * answer `request_in_progress` on the tap that actually happens twice.
   */
  it('sequentially — a second void under a NEW key is 409 already_voided', async () => {
    const charged = await chargeOnce('double-void');
    const first = await treq('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('double-void-1'),
      body: { transactionId: charged.transaction.id, reason: 'first' },
    });
    precondition(first.status === 200, `the first void failed: ${first.raw}`);

    const second = await treq<{ error: string; message: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('double-void-2'),
      body: { transactionId: charged.transaction.id, reason: 'second' },
    });

    expect(second.status, second.raw).toBe(409);
    expect(
      second.body.error,
      'the second void of an already-voided charge reports a transient, retryable condition. ' +
        'It is neither: the charge was refunded and trying again will never succeed.',
    ).toBe('already_voided');
    expect(second.body.error).not.toBe('request_in_progress');
  });

  it('and the SAME key still replays the first void verbatim — a retry is not a double void', async () => {
    /**
     * The distinction the fix must not have collapsed. A gateway or a flaky
     * tablet retrying the identical request with the identical key is
     * non-negotiable #4 working: it gets the original 200 back. Only a NEW key
     * against an already-voided charge is a second attempt, and only that is 409.
     *
     * Answering 409 to both would break every client that retries on a timeout.
     */
    const charged = await chargeOnce('void-replay');
    const idem = key('void-replay');
    const body = { transactionId: charged.transaction.id, reason: 'first' };

    const first = await treq<{ transaction: { id: string } }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: idem,
      body,
    });
    precondition(first.status === 200, `the first void failed: ${first.raw}`);

    const replay = await treq<{ transaction: { id: string } }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: idem,
      body,
    });

    expect(replay.status, `a same-key retry answered ${replay.status} ${replay.raw}`).toBe(200);
    expect(replay.raw, 'the replay was recomputed rather than replayed').toBe(first.raw);
    expect(
      scalar(
        `select count(*) from transaction where reverses_transaction_id='${charged.transaction.id}'`,
      ),
      'the replay wrote a second reversal row',
    ).toBe('1');
  });

  it('racing — two voids at once, one 200 and one 409 already_voided, one reversal row', async () => {
    /**
     * The case the sequential spec cannot reach: two DIFFERENT keys in flight at
     * the same instant, so neither transaction can see the other's uncommitted
     * reversal and the read-first path finds nothing. The unique index resolves
     * it, and `violatedConstraint()` is what turns the loser's error into the
     * right sentence instead of `request_in_progress`.
     */
    const charged = await chargeOnce('void-race');
    const [a, b] = await Promise.all([
      treq<{ error?: string }>('POST', '/voids', {
        token: scanner,
        idempotencyKey: key('void-race-a'),
        body: { transactionId: charged.transaction.id, reason: 'a' },
      }),
      treq<{ error?: string }>('POST', '/voids', {
        token: scanner,
        idempotencyKey: key('void-race-b'),
        body: { transactionId: charged.transaction.id, reason: 'b' },
      }),
    ]);

    expect(
      [a.status, b.status].sort(),
      `the racing voids answered: ${a.raw} / ${b.raw}`,
    ).toEqual([200, 409]);

    const loser = [a, b].find((r) => r.status === 409)!;
    expect(
      loser.body.error,
      'the losing side of a void race is told the request is still processing, which invites ' +
        'a third tap at a charge that has already been refunded',
    ).toBe('already_voided');

    expect(
      scalar(
        `select count(*) from transaction where reverses_transaction_id='${charged.transaction.id}'`,
      ),
      'two reversal rows exist for one charge',
    ).toBe('1');
  });
});

// ===========================================================================
// THE GAP LEDGER — what the API still owes the scanner
// ===========================================================================

/**
 * Lane B built the scanner against the API as it is and reported seven things it
 * had to work around. Each one is written here as an assertion of what the
 * contract or the design actually asks for, so that none of them can be lost in
 * a report nobody re-reads.
 *
 * `knownBug()` where the correct behaviour can be stated as an executable
 * assertion today — those flip to a failing "this appears to be FIXED" the moment
 * the endpoint lands, and ask to be promoted. `it.todo` only where there is
 * genuinely nothing to call yet, because a `knownBug` against a shape nobody has
 * designed would be asserting lane D's guess.
 *
 * THREE OF THE SEVEN ARE GONE FROM HERE and are plain `it()`s above — the manual
 * lookup with its four controls, the voided marker, and `already_voided`. Four
 * remain, and two of those carry a decision that is not lane D's to take.
 *
 * The numbers below are lane B's original seven and are left as they were, so the
 * holes in the sequence — 1, 3, 4 — are the three that closed. Renumbering would
 * make the ledger disagree with the report it came from.
 */
describe('GAP: what the API still owes the scanner', () => {
  // ------------------------------------------------------------------ 2 --
  /**
   * `GET /charges` returns bare `Transaction` rows. The screen it feeds is a list
   * a human reads at the counter, and "TX-4913220 · −7.000 KD" identifies nothing
   * — the staff member cannot tell which customer, which service or which
   * colleague without three more lookups the scanner has no endpoints for.
   */
  knownBug('GET /charges carries no member, service or staff name — the list is unreadable', async () => {
    const charged = await chargeOnce('gap-names');
    const res = await treq<{ items: Array<Record<string, unknown>> }>('GET', '/charges', {
      token: scanner,
    });
    precondition(res.status === 200, `GET /charges answered ${res.status}`);

    const row = res.body.items.find((t) => t.id === charged.transaction.id);
    precondition(row !== undefined, 'the charge just made is not in the list');

    const missing = ['memberName', 'serviceNames', 'staffName'].filter((f) => !(f in row!));
    expect(
      missing,
      'today\'s charges is a list a human reads at the counter; these fields are what makes ' +
        `a row identifiable:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  // ------------------------------------------------------------------ 5 --
  /**
   * CORRECTED — this entry said `POST /scans` hardcodes `heldDepositFils: 0` and
   * that "bookings are not built, so nothing IS ever held". Both halves are now
   * false: `api/src/routes/staff.ts` serves `held?.depositFils ?? 0` from
   * `findApplicableHold`, and `api/drizzle/0013_booking.sql` plus
   * `api/src/services/booking.ts` build the hold for real. The gap is no longer
   * "unreachable", it is UNCOVERED, which is a different and more urgent thing —
   * a stale todo saying a money path cannot be tested is worse than no todo,
   * because it reads as a reason not to look.
   */
  /**
   * COVERED — see `e2e/deposit.test.ts`. This entry twice described a money path as
   * untestable and was twice wrong: first because `POST /scans` was said to hardcode
   * `heldDepositFils: 0`, then because the only booking in the suite was nine days
   * out and so held nothing CORRECTLY. Seven specs now drive it, including migration
   * 0014's case, which nothing had ever produced.
   */

  // ------------------------------------------------------------------ 6 --
  /**
   * THE LOCKED SCREEN CANNOT LIST WHO WOULD UNLOCK IT.
   *
   * Every permission refusal in the design ends "A manager can grant it", and the
   * screen wants to name them. The only roster endpoint is `GET /staff`, which is
   * `requireDashboardPerm(req, 'team')` — so it needs both a dashboard credential
   * and the `team` permission, and is therefore unreadable by precisely the person
   * looking at the locked screen: a frontdesk member on a PIN session.
   *
   * THIS ONE CARRIES A DESIGN QUESTION AND LANE D DOES NOT GET TO ANSWER IT.
   * Making `GET /staff` scanner-readable would put the whole roster — every
   * colleague's handle, role and permission set — on the salon floor tablet. The
   * likelier right answer is a narrow read that returns names only, of the people
   * holding the permission that was refused. The assertion below is for the
   * CAPABILITY, not for that endpoint's shape, so it flips whichever way lane A
   * resolves it.
   */
  knownBug('a locked-out scanner cannot read who could grant the permission', async () => {
    const res = await treq<{ items: Array<{ name: string }> }>('GET', '/staff', {
      token: restricted,
    });

    expect(
      res.status,
      'the scanner\'s locked screen says "a manager can grant it" and has no way to find out who. ' +
        `GET /staff answered ${res.status}: ${res.raw}`,
    ).toBe(200);
    expect(res.body.items.some((s) => typeof s.name === 'string')).toBe(true);
  });

  // ------------------------------------------------------------------ 7 --
  it.todo(
    'NO DEVICE PROVISIONING ENDPOINT — RELEASE BLOCKER, not a pilot blocker. A PIN is only safe ' +
      'because it is bound to a device (staff_user.pin_device_id), and today that binding is set by ' +
      'the seed. Lane B resolved it as one-time enrolment, which is adequate for a pilot on ' +
      'salon-owned hardware and is not adequate for release: there is no way to enrol a replacement ' +
      'tablet, no way to REVOKE a lost one, and a lost tablet is a live scanner credential until ' +
      'somebody edits the database by hand. Needs an owner/manager-authorised enrol + revoke pair, ' +
      'audited, before launch. Cross-reference: go-live-checklist.md',
  );
});

// ----------------------------------------------------------------- 1c --
/**
 * GET /members/{id} — THE SECOND DOOR, AND THE BUDGET IT SHARES WITH THE FIRST.
 *
 * The manual path used to stop at a name: `GET /members?q=` returns a deliberately
 * narrow row — no balance, `phoneLast4` and not the number — and nothing turned
 * that row into something the counter could charge. So "Can't scan? Find member
 * manually" ended one step short of the thing it exists for.
 *
 * `GET /members/{id}` closes it, and it serves the `POST /scans` ENVELOPE rather
 * than a bare Member, which is the decision worth guarding. Two doors, one screen.
 */
describe('GET /members/{id} — the resolve, its envelope, and the directory budget', () => {
  const RESOLVE_ACTION = 'Customer opened';

  const resolve = (token: string, id: string) =>
    treq<any>('GET', `/members/${encodeURIComponent(id)}`, { token });

  /** Rows for one action, for one staff member, however many sessions. */
  const directoryRows = (actorId: string, action: string): number =>
    Number(
      scalar(
        `select count(*) from audit_log where action='${action}' and actor_id='${actorId}'`,
      ),
    );

  it('resolves a member to the SAME envelope POST /scans serves — one builder, not two', async () => {
    /**
     * THE ASSERTION THAT PROTECTS THE SHARED BUILDER, and the reason it is worth
     * more than a schema on either path.
     *
     * This codebase has already paid for two hand-assembled copies of this
     * payload: `heldDepositFils` was hardcoded `0` on the scan path while the
     * charge path read it for real, so the credit line the customer was SHOWN and
     * the credit the charge APPLIED were different answers, and the one on the
     * screen is the one she was told. `services/counter.ts` is one function now.
     *
     * DEEP-EQUAL, not field-by-field: a spec that checked the fields it thought of
     * would have missed `heldDepositFils` for exactly the same reason the bug did.
     * The envelope carries no timestamp of its own, so the two calls are directly
     * comparable — and if a clock-dependent field is ever added, this spec going
     * red is the correct way to find out.
     */
    const walletToken = await freshWalletToken();
    const scanned = await treq<any>('POST', '/scans', {
      token: scanner,
      body: { token: walletToken },
    });
    precondition(scanned.status === 200, `POST /scans answered ${scanned.status} ${scanned.raw}`);

    const opened = await resolve(scanner, B_MEMBER);
    expect(opened.status, opened.raw).toBe(200);

    expect(
      opened.body,
      'the two doors onto the counter screen serve different envelopes. They are built by one ' +
        'function precisely so they cannot — and the last time they were built twice, the held ' +
        'deposit was 0 on one path and real on the other.',
    ).toEqual(scanned.body);

    // And it is the envelope, not a bare Member: the fields the charge screen needs.
    expect(Object.keys(opened.body).sort()).toEqual(
      ['heldDepositBooking', 'heldDepositFils', 'member', 'services'].sort(),
    );
    expect(opened.body.member.id).toBe(B_MEMBER);

    /**
     * AND THE HONEST LIMIT OF THIS SPEC, MEASURED RATHER THAN ASSUMED.
     *
     * `heldDepositFils` is 0 for this member, because nothing in this file books
     * her. So the deep comparison above is at its WEAKEST on precisely the field
     * whose divergence was the original bug: a break that hardcoded
     * `heldDepositFils: 0` on this door was applied deliberately and the spec stayed
     * GREEN, because 0 is what the shared builder returns here anyway. A break that
     * made it 500 was caught immediately.
     *
     * That is the "no empty samples" rule from contract.test.ts turning up on the
     * counter: a comparison whose interesting value is zero on both sides proves
     * less than it appears to. Asserted rather than left as a comment, so that when
     * the deposit slice gives this member a real hold, this expectation fails and
     * whoever is holding it is told to move the comparison onto the non-zero case —
     * which is the version that would have caught the original defect.
     */
    expect(
      opened.body.heldDepositFils,
      'this member now HAS a held deposit, which means the envelope comparison above has finally ' +
        'become able to catch the divergence it was written for. Move it onto a member with a ' +
        'live hold — booked INSIDE the no-show grace window — and delete this expectation.',
    ).toBe(0);
  });

  it('is salon-scoped — a member id from another salon is 404, not a leak', async () => {
    const res = await resolve(scanner, A_MEMBER);
    expect(
      res.status,
      `salon B opened salon A's customer by id: ${res.raw}`,
    ).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    // The refusal must not confirm she exists somewhere else.
    expect(res.raw, 'the 404 leaked the foreign member\'s name').not.toContain('Dana');
  });

  it('writes an audit row BEFORE the 404, because a refused id is what a walk looks like', async () => {
    const before = directoryRows(B_STAFF, RESOLVE_ACTION);

    const missing = await resolve(scanner, 'MEMBER-DOES-NOT-EXIST');
    precondition(missing.status === 404, `answered ${missing.status} ${missing.raw}`);

    /**
     * The row is written whether or not she was found, and that is the whole
     * design: a staff member trying ids that are not in her salon is precisely
     * what enumerating the directory looks like from the inside, and it is the case
     * a log that only recorded successes could not show anybody.
     */
    expect(
      directoryRows(B_STAFF, RESOLVE_ACTION),
      'a resolve that found nobody wrote no audit row, so trying ids until one lands is the one ' +
        'access pattern this log cannot see',
    ).toBe(before + 1);

    const detail = scalar(
      `select detail from audit_log where action='${RESOLVE_ACTION}'
         and actor_id='${B_STAFF}' order by seq desc limit 1`,
    );
    expect(detail, 'the row does not record which id was attempted').toContain(
      'MEMBER-DOES-NOT-EXIST',
    );
  });

  it('and an unauthorised resolve writes NO row — authorisation fails before any read', async () => {
    const web = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    const before = directoryRows(B_STAFF, RESOLVE_ACTION);

    const res = await resolve(web, B_MEMBER);
    precondition(res.status === 403, `a dashboard session resolved a member: ${res.raw}`);

    // Symmetrical with the search: a refusal that logged would charge the caller
    // for a read that never happened, and on the shared ceiling below that is a
    // way to spend somebody else's hour.
    expect(
      directoryRows(B_STAFF, RESOLVE_ACTION),
      'a 403 wrote a "Customer opened" row, so the log claims a customer was opened when the ' +
        'request never reached the member table',
    ).toBe(before);
  });

  /**
   * THE SHARED BUDGET, PROVED ACROSS THE DOORS RATHER THAN WITHIN ONE.
   *
   * Both tiers now count searches AND resolves against one allowance, on the
   * reasoning that a resolve discloses strictly more than a search row — the full
   * phone, the email, the balance, the visits — so the unit being protected is the
   * DIRECTORY and not an endpoint. A ceiling that counted only searches would be
   * bypassable by walking ids instead of names, which is the cheaper attack and the
   * one that returns more.
   *
   * So the budget is filled with RESOLVES ONLY, never a search, and then a SEARCH
   * is refused. Testing either endpoint against its own rows could never show that.
   */
  it('spends one allowance across BOTH doors — an hour of resolves refuses the next search', async () => {
    resetPinState(B_STAFF_CROSSDOOR, B_CROSSDOOR_DEVICE);
    const fresh = await signInScanner(
      SALON_B,
      B_STAFF_CROSSDOOR_HANDLE,
      B_CROSSDOOR_DEVICE,
    );
    const sid = sessionIdOf(fresh);
    precondition(lookupsLogged(sid) === 0, 'this session has already searched');
    precondition(
      directoryRows(B_STAFF_CROSSDOOR, RESOLVE_ACTION) === 0,
      'this staff member has already resolved somebody',
    );

    // A full hour of RESOLVES, under a different session so the burst tier cannot
    // see them, and not one search among them.
    backdateDirectoryReads(
      B_STAFF_CROSSDOOR,
      RESOLVE_ACTION,
      SEARCH_MAX_PER_HOUR,
      30,
      'not-this-session',
    );

    const searched = await search(fresh, 'Fatima');
    expect(
      searched.body.error,
      `${SEARCH_MAX_PER_HOUR} RESOLVES in the last hour did not stop the next SEARCH ` +
        `(${searched.status} ${searched.raw}). If the ceiling counts only searches, walking ids ` +
        'is an unlimited directory read that returns strictly more than a search row does — the ' +
        'full phone, the email, the balance and the visit count.',
    ).toBe('lookup_hourly_limit');

    // And it is HER hour, not everyone's: the ceiling is per staff member, so a
    // colleague at the same salon on the same device is unaffected.
    resetPinState(B_STAFF_RESTRICTED, B_RESTRICTED_DEVICE);
    const colleague = await signInScanner(
      SALON_B,
      B_STAFF_RESTRICTED_HANDLE,
      B_RESTRICTED_DEVICE,
    );
    const hers = await search(colleague, 'Fatima');
    expect(
      hers.status,
      `one staff member's spent hour refused a different staff member: ${hers.raw}`,
    ).toBe(200);
  }, 120_000);
});
