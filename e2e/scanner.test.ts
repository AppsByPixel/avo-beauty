/**
 * THE STAFF SCANNER — the surface a salon actually touches.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --filter @avo/api run db:up
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
  resetPinState,
  scalar,
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
// THE GAP LEDGER — the seven things the API owes the scanner
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
 */
describe('GAP: what the API owes the scanner', () => {
  // ------------------------------------------------------------------ 1 --
  /**
   * MANUAL LOOKUP. The scanner has a "find her by name or number" path for the
   * customer whose phone is flat, and it renders "No such endpoint" today.
   *
   * The design promises the CUSTOMER that this is logged — which makes the audit
   * row part of the feature and not a nice-to-have. The other three requirements
   * are what stop a staff-facing search box from being a customer-list export:
   * salon scoping, a minimum query length so a single letter cannot enumerate the
   * salon, and a rate limit.
   */
  knownBug('GET /members?q= does not exist — the scanner cannot look a customer up by name', async () => {
    const res = await treq<{ items: Array<{ id: string; salonId: string }> }>(
      'GET',
      '/members?q=Fatima',
      { token: scanner },
    );

    expect(res.status, `GET /members?q= answered ${res.status} ${res.raw}`).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.map((m) => m.id)).toContain(B_MEMBER);
    // Salon-scoped, or a staff member at one salon can search every customer AVO
    // has.
    expect(res.body.items.every((m) => m.salonId === SALON_B)).toBe(true);
  });

  it.todo(
    'GET /members?q= must enforce a MINIMUM QUERY LENGTH — a one-character query returns the salon, ' +
      'which makes the lookup a customer-list export. Cannot be written until the endpoint exists',
  );
  it.todo(
    'GET /members?q= must be RATE LIMITED per session — otherwise the search box walks the ' +
      'name space at whatever speed the tablet can manage. Cannot be written until the endpoint exists',
  );
  it.todo(
    'GET /members?q= must write an AUDIT ROW per lookup naming the staff member and the query — ' +
      'design/AVO Staff Scanner.dc.html promises the customer that lookups are logged, so the ' +
      'audit row is part of the feature. Assert kind=access against audit_log once it exists',
  );

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

  // ------------------------------------------------------------------ 3 --
  /**
   * NO VOIDED INDICATOR. The money is safe — the unique index makes a second void
   * impossible, and the spec above proves it. The UI is wrong: an already-voided
   * charge still offers "Void this charge", so the staff member presses it in
   * front of the customer and gets an error for doing what the screen invited.
   */
  knownBug('GET /charges does not mark a voided charge, so the scanner offers to void it again', async () => {
    const charged = await chargeOnce('gap-voided-flag');
    const voided = await treq('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('gap-voided-flag'),
      body: { transactionId: charged.transaction.id, reason: 'to mark it voided' },
    });
    precondition(voided.status === 200, `the void failed: ${voided.raw}`);

    const res = await treq<{ items: Array<Record<string, unknown>> }>('GET', '/charges', {
      token: scanner,
    });
    const row = res.body.items.find((t) => t.id === charged.transaction.id);
    precondition(row !== undefined, 'the voided charge left the list entirely');

    // Any honest signal will do — the field name is lane A's to choose. What must
    // not happen is a voided charge that looks exactly like a live one.
    const marked =
      row!.voided === true ||
      row!.status === 'voided' ||
      typeof row!.voidedAt === 'string' ||
      typeof row!.reversedByTransactionId === 'string';

    expect(
      marked,
      `the voided charge ${charged.transaction.id} is indistinguishable from a live one in ` +
        `today's charges: ${JSON.stringify(row)}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------ 4 --
  /**
   * DOUBLE VOID ANSWERS THE WRONG THING. The second void hits the unique index on
   * `reverses_transaction_id`; `withIdempotency` catches the unique violation,
   * assumes it was the IDEMPOTENCY key that collided, looks for the winner's
   * stored response under a key that never existed, finds nothing, and answers
   * `409 request_in_progress`.
   *
   * So the scanner tells the staff member "that request is still being processed,
   * try again in a moment" — advice that is wrong, that invites a third attempt,
   * and that hides the true state, which is that the charge was already refunded.
   * `already_voided` is a different sentence and a different screen.
   */
  knownBug('a double void answers request_in_progress rather than already_voided', async () => {
    const charged = await chargeOnce('gap-double-void');
    const first = await treq('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('gap-double-void-1'),
      body: { transactionId: charged.transaction.id, reason: 'first' },
    });
    precondition(first.status === 200, `the first void failed: ${first.raw}`);

    const second = await treq<{ error: string; message: string }>('POST', '/voids', {
      token: scanner,
      idempotencyKey: key('gap-double-void-2'),
      body: { transactionId: charged.transaction.id, reason: 'second' },
    });

    expect(second.status).toBe(409);
    expect(
      second.body.error,
      'the second void of an already-voided charge reports a transient, retryable condition. ' +
        'It is neither: the charge was refunded and trying again will never succeed.',
    ).toBe('already_voided');
  });

  // ------------------------------------------------------------------ 5 --
  it.todo(
    'POST /scans hardcodes heldDepositFils: 0 (api/src/routes/staff.ts), so the scanner\'s ' +
      '"deposit applied" credit line is unreachable and untestable. It is not a bug on its own — ' +
      'bookings are not built, so nothing IS ever held — but the line renders money and has never ' +
      'been exercised with a non-zero value. Needs the booking deposit from build-plan.md phase 3; ' +
      'assert then that the charge is reduced by the held amount and depositAppliedFils reports it',
  );

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
