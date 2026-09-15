/**
 * ONE REFUSAL, FIVE STATES — the security property `routes/vouchers.ts` argues for
 * and nothing asserted.
 *
 * The header of that file resolves a real tension out loud:
 *
 *   "the states must be distinguishable to HER and indistinguishable to an
 *    ATTACKER enumerating codes, and those conflict. RESOLVED TOWARD THE
 *    ATTACKER, because her recovery path is identical in every case — she
 *    contacts support, who CAN tell them apart from the row."
 *
 * So expired, voided, already redeemed, never existed and another member's code
 * all answer ONE 409 with ONE body. That is a deliberate decision with money and
 * an enumeration oracle behind it, and until this file existed it was enforced by
 * nothing: a change that made "never existed" a 404, or that added a helpful
 * `expired: true` to the body, would have passed every gate this repository runs.
 * The route's own integration tests assert the money path; the census asserts the
 * gate; neither asks whether the five refusals agree.
 *
 * WHY THE ASSERTION IS MUTUAL IDENTITY AND NOT A PINNED STRING.
 * ------------------------------------------------------------
 * "All five are 409" is much too weak — two 409s with different `error` codes
 * leak the state just as completely as a 404 does. "All five equal this literal"
 * is too strong in the wrong direction: it pins display copy, so a legitimate
 * rewording goes red while a sixth state answering something new stays green,
 * which is precisely backwards. What the decision actually says is that the
 * refusals are INDISTINGUISHABLE FROM EACH OTHER. So that is what is asserted —
 * the set of served bodies has exactly one member — and it holds however many
 * states there come to be, including ones nobody has written yet.
 *
 * Two narrower assertions sit beside it because identity alone would tolerate
 * five identically-leaky bodies: the shared body is exactly `{error, message}`
 * (so `expired: true` cannot arrive on all five at once and pass), and its
 * `error` is `voucher_not_redeemable` (so the shared answer is the refusal and
 * not, say, a shared 500).
 *
 * THE CONTROL, AND WHY THE FILE IS WORTHLESS WITHOUT IT.
 * -----------------------------------------------------
 * Five identical refusals are also what a completely broken endpoint serves. A
 * redeem that SUCCEEDS runs in the same hook, against a voucher issued by the
 * same console call, for the same member — so "the endpoint refuses everything"
 * and "the endpoint refuses these five" are told apart by evidence rather than by
 * assumption. The control is also what makes state 1 reachable: the code it
 * spends is the code the `already redeemed` probe then re-sends.
 *
 * AND THE STATES ARE PROVED TO BE FIVE DIFFERENT STATES.
 * -----------------------------------------------------
 * The failure mode of a file like this is vacuity: if the fixture that expires a
 * voucher silently did nothing, that row would refuse for being somebody's live
 * code or not refuse at all, and the identity assertion would still be green —
 * five bodies that agree because four of them are the same case. So a spec reads
 * the five rows back out of Postgres and asserts each is in the state its label
 * claims, including that the "never existed" code really matches zero rows and
 * that the other member's voucher is still LIVE and simply not hers.
 *
 * THIS IS THE SECOND UNIFORM-REFUSAL ORACLE IN THE SUITE, AND THE FIRST ONE IS
 * THE PRECEDENT RATHER THAN A COINCIDENCE.
 * ----------------------------------------------------------------------------
 * `report-download-capability.test.ts` § "One uniform refusal, so a probe cannot
 * tell the four apart" pins the same property on `invalid_download`: unknown,
 * expired, spent and revoked, one 401, one body, asserted as a set of size one.
 * Written before this file and arrived at independently by lane A, which is the
 * argument that the shape is the product's rather than one route's.
 *
 * Three things here are deliberately not there, each because a voucher is money
 * and a download link is not: the STATUS is asserted in its own spec (a 404 on
 * the ghost code leaks the whole set even with an identical body), the shared
 * body's KEY SET is pinned (so an `expired: true` added to all five at once
 * cannot slip past an identity check that would still see one distinct string),
 * and the five refusals are asserted to have MOVED NO MONEY. The vacuity guard
 * is also lifted out into its own spec rather than left as four preconditions,
 * so a fixture that stopped working is a named failure and not a silent pass.
 *
 * WHAT THIS FILE DOES NOT COVER, said rather than left implied: a TIMING channel.
 * The five paths do different amounts of work — the ghost code stops at the first
 * SELECT, the redeemed one walks the same predicate — and a response body being
 * identical says nothing about how long it took to produce. Distinguishing them
 * that way needs her session AND a sustained measurement, which is the second
 * half of the route's own "enumeration needs her session and her code" argument,
 * and it is not something this suite can assert without becoming a benchmark.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import { api, targetKind } from './support/api.js';
import { VoucherSchema, paginated } from '../packages/types/dist/index.js';
import {
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  psql,
  scalar,
  signInMember,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * TWO MEMBERS OF THIS FILE'S OWN, cloned from `QA-GW-0001` for the password hash
 * the way `adjustments.test.ts` and the salon B seed both do it: `hashSecret()` is
 * one function for staff and members, so a copied hash cannot drift out of step
 * with the seed the way a pasted constant would.
 *
 * NEW ROWS RATHER THAN A SEEDED MEMBER, because redeeming moves money: a
 * `transaction`, a `ledger_entry` pair and an `audit_log` row against whoever is
 * named here. `QA-GW-0001`'s numbers are what `gateway.test.ts` measures its
 * deltas against.
 */
const HER = 'QA-VCH-0001';
const HER_PHONE = '+96555990201';
const OTHER = 'QA-VCH-0002';
const OTHER_PHONE = '+96555990202';
const CLONE_SOURCE = 'QA-GW-0001';

/**
 * A code that is not in the table. Twelve characters from `mintCode`'s own
 * Crockford-ish alphabet, so it is a code the server could have minted and is
 * refused for not existing rather than for failing a format check — the route has
 * no format check, and a code shaped differently would prove nothing about the
 * one that matters. Asserted absent in the discriminator spec below.
 */
const GHOST_CODE = 'ZZZZZZZZZZZZ';

let owner = '';
let her = '';

let n = 0;
const key = (label: string) => `vch-${label}-${Date.now()}-${n++}`;

interface Refusal {
  /** The state under test, as the route header names it. */
  state: string;
  /** The voucher row it was driven against. Null for the code that never existed. */
  voucherId: string | null;
  status: number;
  /** The response EXACTLY as it came off the wire. The subject of this file. */
  raw: string;
}

const refusals: Refusal[] = [];
let control: { status: number; body: any; raw: string } | undefined;
let controlVoucherId = '';
let balanceBefore = 0;
let balanceAfterAllFive = 0;

const balanceOf = (id: string): number =>
  Number(scalar(`select balance_fils from member where id='${id}'`));

/** `POST /v1/vouchers` — the console issues. No idempotency key: it moves no money. */
async function issue(memberId: string, amountFils: number, reason: string): Promise<any> {
  const res = await treq<any>('POST', '/v1/vouchers', {
    token: owner,
    body: { memberId, amountFils, reason },
  });
  if (res.status !== 201) {
    throw new Error(
      `POST /v1/vouchers (${reason}): ${res.status} ${res.raw}\n` +
        'This route is gated requirePlatform(accounts). A 403 means the console credential ' +
        'lost that section, which is permission-census.test.ts\'s subject, not this file\'s.',
    );
  }
  return res.body.voucher;
}

/** `POST /members/me/vouchers/redeem` — she sends a code and nothing else. */
const redeem = (token: string, code: string, label: string) =>
  treq<any>('POST', '/members/me/vouchers/redeem', {
    token,
    idempotencyKey: key(label),
    body: { code },
  });

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);

  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${HER}', salon_id, 'Voucher QA', '${HER_PHONE}', NULL, false,
           password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = 0, erased_at = NULL;

    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${OTHER}', salon_id, 'Voucher QA other', '${OTHER_PHONE}', NULL, false,
           password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = 0, erased_at = NULL;
  `);

  precondition(
    scalar(`select count(*) from member where id in ('${HER}','${OTHER}')`).trim() === '2',
    `the clone source ${CLONE_SOURCE} is missing, so this file has no members to issue to`,
  );

  her = await signInMember(SALON_A, HER_PHONE);

  // ---- the control, first, because state 1 spends what it redeems --------------
  const live = await issue(HER, 4_000, 'voucher QA · control');
  controlVoucherId = live.id;
  balanceBefore = balanceOf(HER);
  control = await redeem(her, live.code, 'control');

  /**
   * EVERY REFUSAL IS ANSWERED TO THE SAME PRINCIPAL, and that is deliberate
   * rather than incidental: if "another member's code" were driven as the OTHER
   * member, a difference in the bodies could be a difference between two sessions
   * rather than between two states. Her session is the only one that redeems here,
   * so the caller is held constant and the STATE is the only thing varying.
   */

  // 1 · already redeemed — the control's own code, sent a second time.
  const again = await redeem(her, live.code, 'again');
  refusals.push({ state: 'already redeemed', voucherId: live.id, status: again.status, raw: again.raw });

  // 2 · expired. The console REFUSES a past `expiresAt` at issue ("a voucher that
  //     is already expired at issue is a voucher nobody can redeem"), so the only
  //     way to reach this state is to let time pass — which is what this UPDATE is.
  const expiring = await issue(HER, 4_100, 'voucher QA · expired');
  psql(`UPDATE voucher SET expires_at = now() - interval '1 day' WHERE id = '${expiring.id}';`);
  const expired = await redeem(her, expiring.code, 'expired');
  refusals.push({ state: 'expired', voucherId: expiring.id, status: expired.status, raw: expired.raw });

  // 3 · voided, through the console's own recall rather than an UPDATE.
  const voiding = await issue(HER, 4_200, 'voucher QA · voided');
  const voided = await treq<any>('DELETE', `/v1/vouchers/${voiding.id}`, { token: owner });
  if (voided.status !== 200) {
    throw new Error(`DELETE /v1/vouchers/${voiding.id}: ${voided.status} ${voided.raw}`);
  }
  const afterVoid = await redeem(her, voiding.code, 'voided');
  refusals.push({ state: 'voided', voucherId: voiding.id, status: afterVoid.status, raw: afterVoid.raw });

  // 4 · never existed.
  const ghost = await redeem(her, GHOST_CODE, 'ghost');
  refusals.push({ state: 'never existed', voucherId: null, status: ghost.status, raw: ghost.raw });

  // 5 · another member's live code, sent by her.
  const notHers = await issue(OTHER, 4_300, 'voucher QA · another member');
  const stolen = await redeem(her, notHers.code, 'not-hers');
  refusals.push({
    state: "another member's code",
    voucherId: notHers.id,
    status: stolen.status,
    raw: stolen.raw,
  });

  balanceAfterAllFive = balanceOf(HER);
}, 180_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================

describe('the control — the endpoint does redeem, so a refusal is evidence', () => {
  it('a live voucher redeems: 200, the credit is the voucher amount, the balance is the server\'s', () => {
    expect(control, 'beforeAll did not record the control').toBeDefined();
    expect(
      control!.status,
      `the control redeem answered ${control!.status}: ${control!.raw}\n` +
        'Every refusal below is worthless if the endpoint cannot redeem anything at all — ' +
        'that is the whole reason this spec exists.',
    ).toBe(200);

    expect(control!.body.creditedFils, 'the credit is not the voucher amount').toBe(4_000);
    /** Non-negotiable #1 — integer fils on the wire, never a formatted string. */
    expect(typeof control!.body.balanceAfterFils).toBe('number');
    expect(Number.isInteger(control!.body.balanceAfterFils)).toBe(true);
    /**
     * #2 — the server owns the balance. The reply's number is the stored number,
     * not the client's arithmetic on a figure it was holding.
     */
    expect(control!.body.balanceAfterFils, 'the reply disagrees with the arithmetic').toBe(
      balanceBefore + 4_000,
    );
    expect(control!.body.voucher.redeemable, 'a spent voucher still reports redeemable').toBe(false);
    expect(control!.body.voucher.redeemedAt, 'a spent voucher carries no redeemedAt').not.toBeNull();
  });
});

describe('every failing redeem answers ONE refusal — five states, one body', () => {
  it('all five states are driven, and each is genuinely the state it claims', () => {
    expect(refusals.map((r) => r.state)).toEqual([
      'already redeemed',
      'expired',
      'voided',
      'never existed',
      "another member's code",
    ]);

    const rowState = (id: string) =>
      scalar(
        `select case
                  when redeemed_at is not null then 'redeemed'
                  when voided_at   is not null then 'voided'
                  when expires_at is not null and expires_at <= now() then 'expired'
                  else 'live'
                end
           from voucher where id = '${id}'`,
      ).trim();

    /**
     * THE VACUITY GUARD. Without this, a fixture that quietly failed — an UPDATE
     * that matched no row, a DELETE that 404'd — would leave two probes driving
     * the SAME state, and five bodies would agree for a reason that has nothing to
     * do with the decision under test.
     */
    expect(rowState(refusals[0]!.voucherId!), 'the `already redeemed` row is not redeemed').toBe(
      'redeemed',
    );
    expect(rowState(refusals[1]!.voucherId!), 'the `expired` row is not expired').toBe('expired');
    expect(rowState(refusals[2]!.voucherId!), 'the `voided` row is not void').toBe('voided');
    expect(
      scalar(`select count(*) from voucher where code = '${GHOST_CODE}'`).trim(),
      `${GHOST_CODE} exists after all, so the "never existed" probe is testing something else`,
    ).toBe('0');
    /**
     * The other member's voucher is LIVE and simply not hers — which is the whole
     * of state 5. A voucher that had expired or been voided underneath this probe
     * would make it a duplicate of state 2 or 3.
     */
    expect(rowState(refusals[4]!.voucherId!), "the other member's row is not live").toBe('live');
    expect(
      scalar(`select member_id from voucher where id = '${refusals[4]!.voucherId}'`).trim(),
      "state 5's voucher does not belong to the other member",
    ).toBe(OTHER);
    /**
     * And the control's voucher is re-used by exactly ONE of the five. If a
     * second probe were driven against it, that probe would be a duplicate of
     * state 1 wearing another label — the same vacuity as an UPDATE that matched
     * no row, arriving from the other direction.
     */
    expect(
      refusals.filter((r) => r.voucherId === controlVoucherId).map((r) => r.state),
      'only the `already redeemed` probe may re-use the control voucher',
    ).toEqual(['already redeemed']);
  });

  it('all five answer 409 — not a 404 for the one that does not exist', () => {
    const wrong = refusals.filter((r) => r.status !== 409);
    expect(
      wrong.map((r) => `${r.state} → ${r.status} ${r.raw}`),
      'A refusal that answers a different STATUS is an enumeration oracle even when the body ' +
        'is identical: 404 on the code that never existed tells an attacker which of his ' +
        'guesses are real codes belonging to somebody. routes/vouchers.ts resolves this ' +
        'toward the attacker deliberately — see its header.',
    ).toEqual([]);
  });

  it('and ONE body: the five refusals are byte-identical to each other', () => {
    const distinct = [...new Set(refusals.map((r) => r.raw))];
    expect(
      distinct.length === 1
        ? ''
        : refusals.map((r) => `  ${r.state.padEnd(22)} ${r.raw}`).join('\n'),
      'THE FIVE STATES NO LONGER ANSWER THE SAME BYTES.\n\n' +
        'This is the property routes/vouchers.ts argues for in its header and the reason this ' +
        'file exists: expired, voided, already redeemed, never existed and another member\'s ' +
        'code must be indistinguishable to somebody enumerating codes, because her recovery ' +
        'path is identical in every case — she contacts support, who can tell them apart from ' +
        'the row.\n\n' +
        'Asserted as MUTUAL IDENTITY rather than against a pinned string, so it keeps holding ' +
        'when the copy is reworded and keeps holding for a SIXTH state nobody has written yet. ' +
        'If the refusals genuinely should diverge, that is a decision for Aftab with an ' +
        'enumeration oracle on the other side of it — not a test to relax.\n\n' +
        'What each state served:\n',
    ).toBe('');
  });

  it('that one body names no state — exactly {error, message}, and the error is the refusal', () => {
    const body = JSON.parse(refusals[0]!.raw) as Record<string, unknown>;
    expect(
      Object.keys(body).sort(),
      'The shared refusal grew a key. A helpful `expired: true` or `redeemed: true` here ' +
        'hands an enumerator the state the identity above was protecting — and it would do it ' +
        'on all five at once, which is exactly the shape the identity assertion cannot see.',
    ).toEqual(['error', 'message']);
    expect(body.error, 'the shared answer is not the refusal').toBe('voucher_not_redeemable');
    expect(typeof body.message, 'the refusal carries no display copy').toBe('string');
    expect((body.message as string).length, 'the refusal carries empty display copy').toBeGreaterThan(0);
  });

  it('and not one of the five moved money', () => {
    /**
     * The other half of a refusal. A 409 that had already credited the wallet would
     * satisfy every assertion above and be the worst defect in the file's subject —
     * `POST /charges` is one transaction (#3) and so is this, so the rollback is the
     * thing that makes the refusal true.
     */
    expect(
      balanceAfterAllFive,
      'her balance moved across five refused redemptions. The credit, the transaction row and ' +
        'the ledger pair commit together or not at all — a refusal that left any of them behind ' +
        'is non-negotiable #3 broken.',
    ).toBe(balanceBefore + 4_000);

    expect(
      scalar(
        `select count(*) from "transaction" where member_id='${HER}' and kind='adjustment'`,
      ).trim(),
      'a refused redemption wrote a transaction row',
    ).toBe('1');
  });
});

// ===========================================================================
// packages/mock serves these four routes too — and three of them in a different
// envelope from the API they stand in for.
// ===========================================================================

/**
 * WHICH SERVER `api()` IS POINTED AT, resolved once at collection time — the
 * pattern `permissions.test.ts` uses. `support/api.js` drives `packages/mock`
 * unless `E2E_BASE_URL` overrides it, and against the REAL API these divergences
 * do not exist, so registering them there would be a `knownBug()` reporting a bug
 * that is not present — which is the one failure mode that helper cannot survive.
 */
const MOCK_TARGET = await targetKind();

/**
 * THREE DIVERGENCES, FOUND WHILE WRITING THE PROBES ABOVE AND NOT FIXED HERE:
 * `packages/mock` is not lane D's column.
 *
 * The mock's own voucher header says the one fact it set out to get right was
 * the REFUSAL, and it did — `REDEEM_REFUSAL` is the API's body to the byte, with
 * a comment telling the next person not to add a branch. What it did not mirror
 * is the ENVELOPE, on the two console writes and the list.
 *
 *   POST   /v1/vouchers        API: 201 `{ voucher: {...} }`   mock: 201 `{...}` bare
 *   DELETE /v1/vouchers/:id    API: 200 `{ voucher: {...} }`   mock: 200 `{...}` bare
 *   GET    /v1/vouchers        API: `{items, truncated, nextCursor}`  mock: no `nextCursor`
 *
 * THE FIRST TWO ARE LIVE BREAKS, not stylistic. `apps/dashboard/src/api/vouchers.ts`
 * parses `(raw as Record<string, unknown>).voucher` on both — read at :340 and
 * :383 — so the console's own parser throws against the mock it is supposed to be
 * able to develop against. That is precisely the cost the mock's header says it
 * was added to spare two lanes.
 *
 * THE THIRD IS LATENT AND IS SAID TO BE. No client reads `nextCursor` here — the
 * console's `interface VoucherList` omits it deliberately — so nothing breaks
 * today. It is worth a spec anyway because `paginated(VoucherSchema)` is now the
 * declared shape of that response, and a mock that does not satisfy the shared
 * schema is a mock a future client written against `@avo/types` cannot use.
 *
 * WRITTEN AS `knownBug()` FOR THE REASON THAT HELPER EXISTS: each assertion below
 * is the CONTRACT, it fails today, and the hour somebody fixes the mock it passes
 * and this spec goes red asking to be promoted. A plain `it()` asserting the
 * mock's current shape would cement the divergence; a sentence in a report would
 * rot.
 */
if (MOCK_TARGET === 'mock') {
  describe('packages/mock serves the voucher routes in a different envelope', () => {
    knownBug(
      'the mock serves POST /v1/vouchers bare, so the console\'s own parser throws on it',
      async () => {
        const res = await api<any>('POST', '/v1/vouchers', {
          body: { memberId: '8842', amountFils: 5_000, reason: 'lane D envelope probe' },
        });
        precondition(
          res.status === 201,
          `the mock refused the issue outright (${res.status}), so the envelope was never reached`,
        );
        expect(
          res.body?.voucher,
          'packages/mock answers the bare voucher where the API answers { voucher }. ' +
            'apps/dashboard/src/api/vouchers.ts:340 reads `raw.voucher` and throws on ' +
            'anything else, so the console cannot be developed against this mock.',
        ).toBeTypeOf('object');
      },
    );

    knownBug(
      'the mock serves DELETE /v1/vouchers/:id bare, the same way and with the same cost',
      async () => {
        const created = await api<any>('POST', '/v1/vouchers', {
          body: { memberId: '8842', amountFils: 5_000, reason: 'lane D void envelope probe' },
        });
        precondition(
          created.status === 201,
          `the mock refused the issue outright (${created.status}), so there is nothing to void`,
        );
        /** Bare or wrapped — read whichever arrived, so this probe is about the DELETE. */
        const id = created.body?.voucher?.id ?? created.body?.id;
        precondition(typeof id === 'string', 'the mock issued a voucher with no id');

        const res = await api<any>('DELETE', `/v1/vouchers/${id}`);
        precondition(res.status === 200, `the mock refused the void (${res.status})`);
        expect(
          res.body?.voucher,
          'packages/mock answers the bare voucher where the API answers { voucher }. ' +
            'apps/dashboard/src/api/vouchers.ts:383 reads `raw.voucher`.',
        ).toBeTypeOf('object');
      },
    );

    knownBug(
      'the mock\'s GET /v1/vouchers does not satisfy paginated(VoucherSchema) — no nextCursor',
      async () => {
        const res = await api<any>('GET', '/v1/vouchers');
        precondition(res.status === 200, `the mock refused the list (${res.status})`);
        const parsed = paginated(VoucherSchema).safeParse(res.body);
        expect(
          parsed.success,
          'The API serves `{items, truncated, nextCursor}` and the mock serves the first two. ' +
            'Latent rather than live — no client reads the cursor on this route — but ' +
            'paginated(VoucherSchema) is now the declared shape, and a mock that does not ' +
            'satisfy the shared schema cannot serve a client written against it.',
        ).toBe(true);
      },
    );
  });
}
