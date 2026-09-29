/**
 * THE SALON'S OWN BOOKING POLICY — a money path, proved end to end.
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run booking-policy.test.ts
 *
 * WHAT IS UNDER TEST
 * ------------------
 * DECISIONS.md § "The fourth list, 2026-09-29" and § "Booking policy: trunk's calls on
 * lane A's build (54308ea)", migration 0066:
 *
 *   PUT /salons/{id}/booking-policy      perms.loyalty; publishes version n+1 and
 *                                        writes one bell notice per member per
 *                                        salon-day; an identical body publishes nothing
 *   POST /bookings { policyVersion }     stamps the current version; a stale one is
 *                                        409 `policy_changed` and nothing is held
 *   DELETE /bookings/{id}                her cancel; the STAMPED cut-offs decide the
 *                                        split, rounded DOWN to the fil; a policy
 *                                        booking needs an Idempotency-Key
 *   POST …/bookings/{id}/no-show         the stamped no-show rule: `keep` forfeits,
 *                                        `return` gives it back
 *   no-show-once.ts (the sweep)          the same rule at `endsAt + grace`
 *   POST …/bookings/{id}/cancel          a salon cancel returns everything, always
 *
 * and the forfeit ledger: `deposit_held` D → `salon_revenue` C on a `deposit_forfeit`
 * transaction whose `amount_fils` is 0, kept off the wire by `WIRE_TRANSACTION_KINDS`.
 *
 * ITS OWN SALON, MINTED PER RUN
 * -----------------------------
 * Salon A and salon B are shared by every file, and a policy is a property of a salon:
 * publishing one at salon A would turn every later booking in `deposit.test.ts` into a
 * policy booking, and the seeded promotions and deposits of those salons would leak into
 * this file's arithmetic. So the salon, its branch, three artists, a service, two staff
 * and three members are created here, under ids carrying this run's stamp. A second run
 * against the same database gets a second salon, so "made before any policy is
 * published" is true on every run rather than only on the first — `booking_policy` is
 * append-only, and nothing could make a salon policy-less again.
 *
 * THE DEPOSIT IS 5.005 KD ON PURPOSE. Half of it is not a whole number of fils: the
 * ruling is that she gets 2.502 and the salon keeps 2.503. `percentOf` in @avo/types
 * rounds half UP and would give her 2.503, which is the defect the API's `splitDeposit`
 * exists to avoid — a round deposit could not tell the two apart.
 *
 * THE GRACE IS SET FOR THIS FILE'S API, NOT READ FROM A DEFAULT
 * --------------------------------------------------------------
 * `BOOKING_SETTLE_GRACE_MINUTES` defaulted to 0 in 54308ea and has defaulted to 60 since
 * lane A's `96fcb35` (merged in `edc4238`). This file went through that change without a
 * red, which is the design working: a spec that assumed either default would have gone
 * red the day the other landed, and would have been asserting env.ts rather than the
 * settle rule. So the API this file boots is given `SETTLE_GRACE_MINUTES` — 45 unless
 * the operator sets one, which is neither default — and every spec reads the constant,
 * and the first sweep spec checks the API really stamped `endsAt + grace`, so a boot that
 * ignored it would fail by name rather than by arithmetic.
 *
 * WHY THE CLOCK IS MOVED AND THE MONEY IS NOT — `deposit.test.ts`'s header, verbatim in
 * spirit. Every booking is made through `POST /bookings` nine or more days out, so the
 * deposit is really held and every invariant the endpoint enforces really runs. Then the
 * booking's three clock columns are moved TOGETHER with SQL, by one delta, so the
 * interval the API stamped between `ends_at` and `no_show_return_due_at` is preserved.
 * No money column is ever written here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingCancelResultSchema,
  BookingPolicyPublishSchema,
  BookingPolicyReadSchema,
  BookingSchema,
} from '../packages/types/dist/index.js';
import { precondition } from './support/known-bug.js';
import { withRowLockHeld } from './support/race.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  apiLogTail,
  pgDb,
  psql,
  reconcileWalletLedger,
  runApiDbScriptAsync,
  runApiDbScriptResult,
  scalar,
  signInDashboard,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ------------------------------------------------------------------ the grace --

/**
 * The slot-end grace THIS FILE'S API runs with. 45 is neither the 0 that shipped nor
 * the 60 it defaults to since `96fcb35`, so a green run proves the variable is read. An operator
 * who exports one is honoured, and the specs follow it.
 */
const SETTLE_GRACE_MINUTES = Number(process.env.BOOKING_SETTLE_GRACE_MINUTES ?? 45);
const inheritedGrace = process.env.BOOKING_SETTLE_GRACE_MINUTES;

/**
 * The salon's frozen legacy window. Distinct from the grace, so a legacy booking and a
 * policy booking made at the same salon stamp visibly different deadlines.
 */
const LEGACY_WINDOW_MINUTES = 90;

// ------------------------------------------------------------------ the salon --

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const SALON = `SAL-QA-BP-${RUN}`;
const BRANCH = `BR-QA-BP-${RUN}`;
const SERVICE = `SV-QA-BP-${RUN}`;
const ART1 = `AR-QA-BP-${RUN}-1`;
const ART2 = `AR-QA-BP-${RUN}-2`;
const ART3 = `AR-QA-BP-${RUN}-3`;
/** Every permission. Publishes, marks, cancels. */
const STAFF = `ST-QA-BP-${RUN}`;
const STAFF_HANDLE = `bp-${RUN.toLowerCase()}`;
/** Dashboard and appointments only: no `loyalty`, no `void`. */
const STAFF_NARROW = `ST-QA-BP-${RUN}-N`;
const STAFF_NARROW_HANDLE = `bp-n-${RUN.toLowerCase()}`;

/** Her. Every booking in this file is hers. */
const HER = `QA-BP-${RUN}-H`;
const HER_PHONE = '+96599778001';
/** Two more members, who book nothing and exist so "one notice per member" counts. */
const M2 = `QA-BP-${RUN}-2`;
const M3 = `QA-BP-${RUN}-3`;
const MEMBERS = [HER, M2, M3];

const OPENING_FILS = 300_000;
/** `salon.deposit_fils`. See the header: half of it is not a whole fil. */
const DEPOSIT = 5_005;
/** 50% of 5.005, rounded DOWN to the fil, and what the salon keeps. The ruling. */
const HALF_BACK = 2_502;
const HALF_KEPT = 2_503;

// ------------------------------------------------------------------ the policies --

/** v1: the salon keeps a no-show; 100% from 48h, 50% from 24h, nothing later. */
const P1 = {
  noShow: 'keep' as const,
  cancellation: [
    { hoursBefore: 48, returnPercent: 100 },
    { hoursBefore: 24, returnPercent: 50 },
  ],
  text: {
    en: 'Cancel 48 hours ahead for a full refund, 24 hours ahead for half. A missed appointment keeps the deposit.',
    ar: 'ألغي قبل ٤٨ ساعة لاسترداد كامل العربون، وقبل ٢٤ ساعة لاسترداد نصفه.',
  },
};
/** v2: the opposite no-show rule and a meaner cut-off, so a v1 booking settling by v2 shows. */
const P2 = {
  noShow: 'return' as const,
  cancellation: [{ hoursBefore: 72, returnPercent: 20 }],
  text: { en: 'Cancel 72 hours ahead for 20% back. A missed appointment is refunded.', ar: '' },
};
/** v3: `keep` again, published last, so a LEGACY no-show settles while the salon keeps. */
const P3 = {
  noShow: 'keep' as const,
  cancellation: [{ hoursBefore: 12, returnPercent: 10 }],
  text: { en: 'Missed appointments keep the deposit.', ar: '' },
};

// ------------------------------------------------------------------ state --

let her = '';
let staff = '';
let narrow = '';
let n = 0;
const key = (label: string) => `bp-${label}-${RUN}-${Date.now()}-${n++}`;

/** Every booking this file makes, for the reconciliation at the end. */
const madeHere: string[] = [];

/**
 * A salon-local clock nowhere near midnight. The bell coalesces on the SALON's calendar
 * day, so a run that straddled its midnight would see a second publish write a notice
 * and read it as the coalescing having broken. The salon is this file's own, so its
 * zone is ours to pick.
 */
function zoneAwayFromMidnight(): string {
  for (const tz of ['Asia/Kuwait', 'Europe/London', 'America/New_York', 'Asia/Tokyo']) {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
        new Date(),
      ),
    );
    if (hour >= 1 && hour <= 22) return tz;
  }
  return 'Asia/Kuwait';
}

function seedSalon(): void {
  const open = { open: true, from: '09:00', to: '21:00' };
  const windows = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), open])));
  const member = (id: string, phone: string, balance: number) => `
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${id}', '${SALON}', 'Policy Fixture ${id.slice(-1)}', '${phone}', NULL, false,
           s.password_hash, ${balance}, 0, 'bronze', NULL,
           (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';`;
  const staffRow = (id: string, handle: string, all: boolean) => `
    INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                            password_hash,
                            perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                            perm_scanner, perm_charges, perm_void, perm_marketing)
    SELECT '${id}', '${SALON}', 'Policy ${all ? 'Manager' : 'Reception'}', '${handle}', 'manager', true, '{}',
           s.password_hash,
           true, true, ${all}, ${all}, ${all}, ${all}, ${all}, ${all}, ${all}
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';`;

  psql(`
BEGIN;
INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${SALON}', 'QA Booking Policy ${RUN}', 'starter', '#7A5C8E', true, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0},{"name":"silver","minVisits":4,"bonusPercent":10}]'::jsonb,
        NULL, NULL, ${DEPOSIT}, ${LEGACY_WINDOW_MINUTES},
        '{"morning":["09:00","13:00"],"evening":["14:00","21:00"]}'::jsonb, '[]'::jsonb, false,
        '${zoneAwayFromMidnight()}');
INSERT INTO branch (id, salon_id, name) VALUES ('${BRANCH}', '${SALON}', 'QA policy branch');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('${SERVICE}', '${SALON}', 'QA policy blow-dry', 9000);
${[ART1, ART2, ART3]
  .map(
    (a, i) => `
INSERT INTO artist (id, salon_id, name, availability_source, google_connected, slot_minutes, windows)
VALUES ('${a}', '${SALON}', 'Policy Artist ${i + 1}', 'manual', false, 30, '${windows}'::jsonb);
INSERT INTO artist_service (artist_id, service_id, salon_id) VALUES ('${a}', '${SERVICE}', '${SALON}');`,
  )
  .join('\n')}
${staffRow(STAFF, STAFF_HANDLE, true)}
${staffRow(STAFF_NARROW, STAFF_NARROW_HANDLE, false)}
${member(HER, HER_PHONE, OPENING_FILS)}
${member(M2, '+96599778002', 0)}
${member(M3, '+96599778003', 0)}
COMMIT;
`);
  // Her opening balance is a real credit with a real ledger pair, so the reconciliation
  // at the end is about what the API did, not about how the fixture was funded.
  reconcileWalletLedger(HER, 'QABP');
}

// ------------------------------------------------------------------ reads --

const balanceOf = (id: string): number =>
  Number(scalar(`select balance_fils from member where id='${id}'`));

const bookingRow = (id: string) => {
  const [status, returned, kept, forfeit, settled, version] = scalar(
    `select concat_ws('|', status, coalesce(settled_returned_fils::text, ''),
                      coalesce(settled_kept_fils::text, ''), coalesce(forfeit_transaction_id, ''),
                      coalesce(settled_transaction_id, ''), coalesce(policy_version::text, ''))
       from booking where id='${id}'`,
  ).split('|');
  return {
    status,
    returned: returned === '' ? null : Number(returned),
    kept: kept === '' ? null : Number(kept),
    forfeitTx: forfeit || null,
    settledTx: settled || null,
    policyVersion: version === '' ? null : Number(version),
  };
};

const countOf = (sql: string): number => Number(scalar(sql));

const herTransactions = (kind: string): number =>
  countOf(`select count(*) from transaction where member_id='${HER}' and kind::text='${kind}'`);

/** The salon's `salon_revenue` position, out of the ledger. Only forfeits credit it here. */
const salonRevenue = (): number =>
  countOf(
    `select coalesce(sum(case when direction='credit' then amount_fils else -amount_fils end), 0)
       from ledger_entry where account='salon_revenue' and salon_id='${SALON}'`,
  );

// ------------------------------------------------------------------ writes --

function isoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A real booking, through the real endpoint, nine or more days out. `policyVersion` is
 * sent exactly as given — omitted when `undefined`, so the pre-0066 client shape is
 * exercised too.
 */
async function book(artistId: string, policyVersion?: number | null): Promise<any> {
  let slot: string | undefined;
  for (let d = 9; d < 30 && !slot; d++) {
    const day = await treq<any>('GET', `/artists/${artistId}/availability?date=${isoDate(d)}`, {
      token: her,
    });
    if (day.status !== 200) throw new Error(`availability: ${day.status} ${day.raw}`);
    slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
  }
  if (!slot) throw new Error(`${artistId} offered no slot in three weeks — a fixture defect, not a policy one`);
  const res = await treq<any>('POST', '/bookings', {
    token: her,
    idempotencyKey: key('book'),
    body: {
      artistId,
      serviceId: SERVICE,
      startsAt: slot,
      ...(policyVersion === undefined ? {} : { policyVersion }),
    },
  });
  if (res.status !== 201) throw new Error(`POST /bookings: ${res.status} ${res.raw}`);
  madeHere.push(res.body.booking.id);
  return res.body.booking;
}

/** Move a booking so it STARTS `minutes` from now, keeping its stamped intervals. */
function startIn(bookingId: string, minutes: number): void {
  psql(`
    UPDATE booking SET
      ends_at               = now() + interval '${minutes} minutes' + (ends_at - starts_at),
      no_show_return_due_at = now() + interval '${minutes} minutes' + (no_show_return_due_at - starts_at),
      starts_at             = now() + interval '${minutes} minutes'
    WHERE id = '${bookingId}';`);
}

/** Move a booking so its slot ENDS `minutes` from now (negative: in the past). */
function endIn(bookingId: string, minutes: number): void {
  psql(`
    UPDATE booking SET
      starts_at             = now() + interval '${minutes} minutes' - (ends_at - starts_at),
      no_show_return_due_at = now() + interval '${minutes} minutes' + (no_show_return_due_at - ends_at),
      ends_at               = now() + interval '${minutes} minutes'
    WHERE id = '${bookingId}';`);
}

/** Move a booking so the sweep is due `minutes` from now (negative: already due). */
function dueIn(bookingId: string, minutes: number): void {
  psql(`
    UPDATE booking SET
      starts_at             = now() + interval '${minutes} minutes' - (no_show_return_due_at - starts_at),
      ends_at               = now() + interval '${minutes} minutes' - (no_show_return_due_at - ends_at),
      no_show_return_due_at = now() + interval '${minutes} minutes'
    WHERE id = '${bookingId}';`);
}

const publish = (body: unknown, token = staff) =>
  treq<any>('PUT', `/salons/${SALON}/booking-policy`, { token, body });

const cancel = (bookingId: string, idempotencyKey?: string) =>
  treq<any>('DELETE', `/bookings/${bookingId}`, {
    token: her,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

const markNoShow = (bookingId: string, token = staff) =>
  treq<any>('POST', `/salons/${SALON}/bookings/${bookingId}/no-show`, {
    token,
    idempotencyKey: key('mark'),
  });

interface Sweep {
  candidates: number;
  returned: number;
  kept: number;
  keptFils: number;
  alreadySettled: number;
  failed: number;
  returnedFils: number;
}

/** One pass of the slot-end sweep, as an operator runs it. `deposit.test.ts` § runNoShowJob. */
function sweep(): Sweep {
  const res = runApiDbScriptResult('src/jobs/no-show-once.ts', pgDb());
  if (!res.ok) throw new Error(`the sweep failed to run\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as Sweep;
}

async function sweepAsync(): Promise<Sweep> {
  const res = await runApiDbScriptAsync('src/jobs/no-show-once.ts', pgDb());
  if (!res.ok) throw new Error(`a racing sweep failed to run\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as Sweep;
}

/** Zod-parse and hand back the parsed value, failing with the error rather than `false`. */
function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T; error?: unknown } }, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  expect(r.success, `${what} does not parse: ${JSON.stringify(r.error)}\n${JSON.stringify(v).slice(0, 600)}`).toBe(true);
  return r.data as T;
}

// ------------------------------------------------------------------ lifecycle --

beforeAll(async () => {
  process.env.BOOKING_SETTLE_GRACE_MINUTES = String(SETTLE_GRACE_MINUTES);
  await startTenancyApi();
  seedSalon();
  her = await signInMember(SALON, HER_PHONE);
  staff = await signInDashboard(SALON, STAFF_HANDLE);
  narrow = await signInDashboard(SALON, STAFF_NARROW_HANDLE);
}, 180_000);

afterAll(async () => {
  /*
   * NOTHING OF THIS FILE'S IS LEFT FOR ANOTHER FILE'S SWEEP. `no-show-once.ts` scans the
   * whole database, so a hold this file left due — a spec that failed half-way — would be
   * settled inside `deposit.test.ts`'s race and change its counts. Every booking still
   * held is parked a year out, one day apart for the artists' exclusion constraint.
   */
  psql(`
    UPDATE booking b SET
      starts_at             = now() + (interval '365 days' + x.i * interval '1 day'),
      ends_at               = now() + (interval '365 days' + x.i * interval '1 day') + (b.ends_at - b.starts_at),
      no_show_return_due_at = now() + (interval '365 days' + x.i * interval '1 day') + (b.no_show_return_due_at - b.starts_at)
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS i
              FROM booking WHERE salon_id = '${SALON}' AND status = 'deposit_held') x
     WHERE b.id = x.id;`);
  await stopTenancyApi();
  if (inheritedGrace === undefined) delete process.env.BOOKING_SETTLE_GRACE_MINUTES;
  else process.env.BOOKING_SETTLE_GRACE_MINUTES = inheritedGrace;
});

// ===========================================================================
// The bookings, named by what they are for. Created in the order the rulings need:
// two before any policy, the v1 set, then the v2 pair.
// ===========================================================================

let L_CANCEL: any;
let L_NOSHOW: any;
let B_STAMP: any;
let C100: any;
let C50: any;
let C0: any;
let IDEM: any;
let K_MARK: any;
let K_SWEEP: any;
let RACE: any;
let S_CANCEL: any;
let R_MARK: any;
let R_SWEEP: any;

describe('booking policy — publish, stamp, settle', () => {
  it('before any publish: the read says `policy: null`, and a booking made now is LEGACY', async () => {
    const read = await treq<any>('GET', `/salons/${SALON}/booking-policy`, { token: her });
    expect(read.status, read.raw).toBe(200);
    expect(parsed(BookingPolicyReadSchema, read.body, 'the policy read').policy).toBeNull();

    L_CANCEL = await book(ART1);
    // `null` is what a client that showed "no policy" sends, and it is current.
    L_NOSHOW = await book(ART3, null);
    for (const b of [L_CANCEL, L_NOSHOW]) {
      const booking = parsed<any>(BookingSchema, b, 'a legacy booking');
      expect(booking.policy, 'a booking made before any publish carries a stamp').toBeNull();
      expect(booking.settlement).toBeNull();
      expect(booking.depositFils).toBe(DEPOSIT);
      // The legacy deadline is the salon's frozen window, not the settle grace.
      expect(Date.parse(booking.noShowReturnDueAt) - Date.parse(booking.endsAt)).toBe(
        LEGACY_WINDOW_MINUTES * 60_000,
      );
    }
  });

  it('PUT is perms.loyalty: reception is refused, and nothing is published', async () => {
    const res = await publish(P1, narrow);
    expect(res.status, res.raw).toBe(403);
    expect(countOf(`select count(*) from booking_policy where salon_id='${SALON}'`)).toBe(0);
    expect(countOf(`select count(*) from member_policy_notice where salon_id='${SALON}'`)).toBe(0);
  });

  it('publishing v1 bumps the version and writes exactly one bell notice per member', async () => {
    const res = await publish(P1);
    expect(res.status, res.raw).toBe(200);
    const body = parsed<any>(BookingPolicyPublishSchema, res.body, 'the publish');
    expect(body.published).toBe(true);
    expect(body.policy.version).toBe(1);
    expect(body.policy.noShow).toBe('keep');
    expect(body.policy.cancellation).toEqual(P1.cancellation);
    expect(body.noticesWritten, 'one notice per member of the salon').toBe(MEMBERS.length);

    for (const m of MEMBERS) {
      expect(
        countOf(`select count(*) from member_policy_notice where salon_id='${SALON}' and member_id='${m}'`),
        `${m} holds the wrong number of notices`,
      ).toBe(1);
    }
    // And nothing reached another salon's members.
    expect(
      countOf(`select count(*) from member_policy_notice n join member m on m.id = n.member_id
                where n.salon_id='${SALON}' and m.salon_id <> '${SALON}'`),
    ).toBe(0);

    // Both doors read what was published.
    for (const token of [her, staff]) {
      const read = await treq<any>('GET', `/salons/${SALON}/booking-policy`, { token });
      expect(read.status, read.raw).toBe(200);
      const policy = parsed<any>(BookingPolicyReadSchema, read.body, 'the policy read').policy;
      expect(policy?.version).toBe(1);
      expect(policy?.text).toEqual(P1.text);
    }

    // Her bell carries it, as its own kind, and says it can.
    const feed = await treq<any>('GET', '/members/me/notifications/feed', { token: her });
    expect(feed.status, feed.raw).toBe(200);
    expect(feed.body.visibleKinds).toContain('booking_policy');
    const notices = feed.body.items.filter((i: any) => i.kind === 'booking_policy');
    expect(notices, feed.raw.slice(0, 800)).toHaveLength(1);
    expect(notices[0]).toMatchObject({ salonId: SALON, policyVersion: 1, readAt: null });
  });

  it('a booking stamps the version she was shown — rules and text both', async () => {
    B_STAMP = await book(ART1, 1);
    C100 = await book(ART1, 1);
    C50 = await book(ART1, 1);
    C0 = await book(ART3, 1);
    IDEM = await book(ART2, 1);
    K_MARK = await book(ART2, 1);
    K_SWEEP = await book(ART1);
    RACE = await book(ART1, 1);
    S_CANCEL = await book(ART1, 1);

    for (const b of [B_STAMP, C100, C50, C0, IDEM, K_MARK, K_SWEEP, RACE, S_CANCEL]) {
      const booking = parsed<any>(BookingSchema, b, 'a policy booking');
      expect(booking.policy, `${booking.id} was not stamped`).not.toBeNull();
      expect(booking.policy.version).toBe(1);
      expect(booking.policy.noShow).toBe('keep');
      expect(booking.policy.cancellation).toEqual(P1.cancellation);
      expect(booking.policy.text).toEqual(P1.text);
      // A policy booking's deadline is the slot end plus THIS API's grace.
      expect(
        Date.parse(booking.noShowReturnDueAt) - Date.parse(booking.endsAt),
        'the API did not stamp endsAt + BOOKING_SETTLE_GRACE_MINUTES — is the env reaching it?',
      ).toBe(SETTLE_GRACE_MINUTES * 60_000);
    }
    expect(balanceOf(HER)).toBe(OPENING_FILS - 11 * DEPOSIT);
  });

  it('publishing v2 the same day writes NO notice; an identical body publishes nothing', async () => {
    const second = await publish(P2);
    expect(second.status, second.raw).toBe(200);
    expect(second.body.published).toBe(true);
    expect(second.body.policy.version).toBe(2);
    expect(second.body.noticesWritten, 'the bell is coalesced to one notice per salon-day').toBe(0);

    const again = await publish(P2);
    expect(again.status, again.raw).toBe(200);
    const body = parsed<any>(BookingPolicyPublishSchema, again.body, 'the identical publish');
    expect(body.published, 'an identical body minted a version').toBe(false);
    expect(body.policy.version).toBe(2);
    expect(body.noticesWritten).toBe(0);

    expect(countOf(`select count(*) from booking_policy where salon_id='${SALON}'`)).toBe(2);
    for (const m of MEMBERS) {
      expect(
        countOf(`select count(*) from member_policy_notice where salon_id='${SALON}' and member_id='${m}'`),
      ).toBe(1);
    }
    const feed = await treq<any>('GET', '/members/me/notifications/feed', { token: her });
    expect(feed.body.items.filter((i: any) => i.kind === 'booking_policy')).toHaveLength(1);
  });

  it('policy_changed: a stale policyVersion is 409 and nothing is held', async () => {
    const before = balanceOf(HER);
    const bookingsBefore = countOf(`select count(*) from booking where member_id='${HER}'`);

    let slot: string | undefined;
    for (let d = 9; d < 30 && !slot; d++) {
      const day = await treq<any>('GET', `/artists/${ART2}/availability?date=${isoDate(d)}`, { token: her });
      slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
    }
    precondition(slot !== undefined, 'no slot to try a stale booking against');

    for (const stale of [1, null]) {
      const res = await treq<any>('POST', '/bookings', {
        token: her,
        idempotencyKey: key('stale'),
        body: { artistId: ART2, serviceId: SERVICE, startsAt: slot, policyVersion: stale },
      });
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error).toBe('policy_changed');
      expect(res.body.policyVersion, 'the refusal does not name the current version').toBe(2);
    }
    expect(balanceOf(HER), 'a refused booking moved money').toBe(before);
    expect(countOf(`select count(*) from booking where member_id='${HER}'`)).toBe(bookingsBefore);

    R_MARK = await book(ART3, 2);
    R_SWEEP = await book(ART2);
    for (const b of [R_MARK, R_SWEEP]) {
      expect(b.policy.version).toBe(2);
      expect(b.policy.noShow).toBe('return');
    }
  });

  it('after the edit, a v1 booking still settles by v1 — 100% where v2 would return 20%', async () => {
    const read = await treq<any>('GET', `/bookings/${B_STAMP.id}`, { token: her });
    expect(read.body.policy.version).toBe(1);
    expect(read.body.policy.cancellation).toEqual(P1.cancellation);

    const before = balanceOf(HER);
    const res = await cancel(B_STAMP.id, key('stamp'));
    expect(res.status, res.raw).toBe(200);
    expect(res.body.returnPercent, 'the salon\'s CURRENT policy decided an existing booking').toBe(100);
    expect(res.body.rule).toEqual({ hoursBefore: 48, returnPercent: 100 });
    expect(res.body.refundedFils).toBe(DEPOSIT);
    expect(balanceOf(HER)).toBe(before + DEPOSIT);
  });

  describe('her cancel at each cut-off — exact fils, three ways', () => {
    /**
     * Five minutes either side of a threshold: close enough that an off-by-an-hour or a
     * `>` for `>=` shows, far enough that the request cannot cross it in flight.
     */
    const cases = [
      { name: '100% — 48h and 5 minutes out', get: () => C100, startsIn: 48 * 60 + 5, percent: 100, back: DEPOSIT, kept: 0, rule: { hoursBefore: 48, returnPercent: 100 } },
      { name: '50% — 24h and 5 minutes out: 2.502 back, the salon keeps 2.503', get: () => C50, startsIn: 24 * 60 + 5, percent: 50, back: HALF_BACK, kept: HALF_KEPT, rule: { hoursBefore: 24, returnPercent: 50 } },
      { name: '0% — 5 minutes inside the last cut-off', get: () => C0, startsIn: 24 * 60 - 5, percent: 0, back: 0, kept: DEPOSIT, rule: null },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const b = c.get();
        startIn(b.id, c.startsIn);
        const before = balanceOf(HER);
        const revenueBefore = salonRevenue();

        const res = await cancel(b.id, key('cut'));
        expect(res.status, res.raw).toBe(200);
        const result = parsed<any>(BookingCancelResultSchema, res.body, 'the cancel result');

        // On the result.
        expect(result.returnPercent).toBe(c.percent);
        expect(result.rule).toEqual(c.rule);
        expect(result.refundedFils, 'what came back to her').toBe(c.back);
        expect(result.keptFils, 'what the salon kept').toBe(c.kept);
        expect(result.transactionId === null, 'a return transaction iff something came back').toBe(c.back === 0);
        expect(result.forfeitTransactionId === null, 'a forfeit iff something was kept').toBe(c.kept === 0);

        // On the booking, as served and as stored.
        expect(result.booking.status).toBe('cancelled');
        expect(result.booking.settlement).toEqual({ returnedFils: c.back, keptFils: c.kept });
        const row = bookingRow(b.id);
        expect([row.returned, row.kept]).toEqual([c.back, c.kept]);

        // On her balance, and on the salon's revenue.
        expect(balanceOf(HER), 'her wallet moved by something other than the return').toBe(before + c.back);
        expect(result.balanceAfterFils).toBe(before + c.back);
        expect(salonRevenue() - revenueBefore, 'the kept fils did not reach salon_revenue').toBe(c.kept);
      });
    }
  });

  it('a retried cancel with the same key replays the answer and moves money once; a new key is already_cancelled', async () => {
    startIn(IDEM.id, 30 * 60);

    // #4 on a policy booking: no key, refused before anything moves.
    const keyless = await cancel(IDEM.id);
    expect(keyless.status, keyless.raw).toBe(400);
    expect(keyless.body.error).toBe('idempotency_key_required');
    expect(bookingRow(IDEM.id).status).toBe('deposit_held');

    const before = balanceOf(HER);
    const returnsBefore = herTransactions('deposit_return');
    const forfeitsBefore = herTransactions('deposit_forfeit');
    const k = key('idem');

    const first = await cancel(IDEM.id, k);
    expect(first.status, first.raw).toBe(200);
    expect([first.body.refundedFils, first.body.keptFils]).toEqual([HALF_BACK, HALF_KEPT]);

    const replay = await cancel(IDEM.id, k);
    expect(replay.status, replay.raw).toBe(200);
    expect(replay.body, 'the retry was answered with a different result').toEqual(first.body);

    expect(balanceOf(HER), 'the retry refunded again').toBe(before + HALF_BACK);
    expect(herTransactions('deposit_return')).toBe(returnsBefore + 1);
    expect(herTransactions('deposit_forfeit')).toBe(forfeitsBefore + 1);

    const fresh = await cancel(IDEM.id, key('idem-new'));
    expect(fresh.status, fresh.raw).toBe(409);
    expect(fresh.body.error).toBe('already_cancelled');
    expect(balanceOf(HER)).toBe(before + HALF_BACK);
  });

  describe('no-show: keep forfeits to the salon, return gives it back — by a mark and by the sweep', () => {
    it('a mark before the slot starts is refused, and a mark without perms.void is refused', async () => {
      const early = await markNoShow(K_SWEEP.id);
      expect(early.status, early.raw).toBe(409);
      expect(early.body.error).toBe('appointment_not_started');

      startIn(K_MARK.id, -5);
      const unauthorised = await markNoShow(K_MARK.id, narrow);
      expect(unauthorised.status, unauthorised.raw).toBe(403);
      expect(bookingRow(K_MARK.id).status).toBe('deposit_held');
    });

    it('keep, by a mark: the whole deposit to salon_revenue, her wallet untouched', async () => {
      const before = balanceOf(HER);
      const revenueBefore = salonRevenue();
      const res = await markNoShow(K_MARK.id);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.refundedFils).toBe(0);
      expect(res.body.keptFils).toBe(DEPOSIT);
      expect(res.body.transactionId).toBeNull();
      expect(res.body.forfeitTransactionId).not.toBeNull();
      expect(res.body.booking.status).toBe('no_show_returned');
      expect(res.body.booking.settlement).toEqual({ returnedFils: 0, keptFils: DEPOSIT });
      expect(balanceOf(HER), 'a kept deposit moved her wallet').toBe(before);
      expect(salonRevenue() - revenueBefore).toBe(DEPOSIT);
    });

    it('return, by a mark: the whole deposit back to her wallet', async () => {
      startIn(R_MARK.id, -5);
      const before = balanceOf(HER);
      const revenueBefore = salonRevenue();
      const res = await markNoShow(R_MARK.id);
      expect(res.status, res.raw).toBe(200);
      expect([res.body.refundedFils, res.body.keptFils]).toEqual([DEPOSIT, 0]);
      expect(res.body.forfeitTransactionId).toBeNull();
      expect(res.body.booking.settlement).toEqual({ returnedFils: DEPOSIT, keptFils: 0 });
      expect(balanceOf(HER)).toBe(before + DEPOSIT);
      expect(res.body.balanceAfterFils).toBe(before + DEPOSIT);
      expect(salonRevenue()).toBe(revenueBefore);
    });

    it('v3 (keep) is published — and it is the third publish of the day, so still no notice', async () => {
      const res = await publish(P3);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.policy.version).toBe(3);
      expect(res.body.noticesWritten).toBe(0);
    });

    it('the sweep does NOTHING while the slot is over but the grace is not', () => {
      precondition(
        SETTLE_GRACE_MINUTES > 2,
        `BOOKING_SETTLE_GRACE_MINUTES is ${SETTLE_GRACE_MINUTES}: there is no window between the ` +
          'slot ending and the sweep being due, so this half cannot be asked',
      );
      // Three artists, so three past slots do not overlap in anybody's diary.
      for (const b of [K_SWEEP, R_SWEEP]) endIn(b.id, -1);
      // The legacy one keeps its own, longer window: also not due a minute after it ends.
      endIn(L_NOSHOW.id, -1);

      sweep();
      for (const b of [K_SWEEP, R_SWEEP, L_NOSHOW]) {
        expect(bookingRow(b.id).status, `${b.id} was settled inside the grace`).toBe('deposit_held');
      }
    });

    it('after slot + grace the sweep settles each by ITS OWN stamp: v1 keeps, v2 returns, legacy returns in full', async () => {
      for (const b of [K_SWEEP, R_SWEEP, L_NOSHOW]) dueIn(b.id, -1);
      const before = balanceOf(HER);
      const revenueBefore = salonRevenue();

      const pass = sweep();
      expect(pass.failed, JSON.stringify(pass)).toBe(0);

      // K_SWEEP: v1 `keep`, although the salon's policy was `return` when v2 was current.
      const k = bookingRow(K_SWEEP.id);
      expect(k.status).toBe('no_show_returned');
      expect([k.returned, k.kept]).toEqual([0, DEPOSIT]);
      expect(k.forfeitTx).not.toBeNull();

      // R_SWEEP: v2 `return`, although the salon's CURRENT policy (v3) is `keep`.
      const r = bookingRow(R_SWEEP.id);
      expect(r.status).toBe('no_show_returned');
      expect([r.returned, r.kept]).toEqual([DEPOSIT, 0]);

      // L_NOSHOW: legacy, full return, while the salon keeps.
      const l = bookingRow(L_NOSHOW.id);
      expect(l.status).toBe('no_show_returned');
      expect(l.policyVersion).toBeNull();
      expect([l.returned, l.kept]).toEqual([DEPOSIT, 0]);

      expect(balanceOf(HER)).toBe(before + 2 * DEPOSIT);
      expect(salonRevenue() - revenueBefore).toBe(DEPOSIT);

      // Served the same way on her own read.
      const served = await treq<any>('GET', `/bookings/${K_SWEEP.id}`, { token: her });
      expect(served.body.settlement).toEqual({ returnedFils: 0, keptFils: DEPOSIT });
    });
  });

  it('THE RACE: the sweep and a manual mark on one `keep` booking settle it exactly once', async () => {
    dueIn(RACE.id, -1);
    // Nothing else of hers may be due, or the sweep's lock on her row is about another booking.
    precondition(
      countOf(`select count(*) from booking where member_id='${HER}' and status='deposit_held'
                 and no_show_return_due_at <= now() and id <> '${RACE.id}'`) === 0,
      'another of her holds is due, so the sweep would contend on her row for the wrong booking',
    );

    const before = balanceOf(HER);
    const revenueBefore = salonRevenue();
    const forfeitsBefore = herTransactions('deposit_forfeit');
    const returnsBefore = herTransactions('deposit_return');

    /**
     * ARRANGED, NOT HOPED FOR — `support/race.ts` § withRowLockHeld. Both contenders lock
     * the MEMBER first (`markNoShow` and `noShowWorker.ts` share that order with the
     * charge), so holding her row stops both after their unlocked reads, and the helper
     * does not release until it has seen two backends blocked on it. So each one read the
     * booking as `deposit_held`, and exactly one can win.
     */
    const [mark, pass] = await withRowLockHeld({ table: 'member', id: HER }, 2, () =>
      Promise.all([markNoShow(RACE.id), sweepAsync()]),
    );
    const shape = `mark: ${mark.status} ${mark.raw.slice(0, 300)} | sweep: ${JSON.stringify(pass)}`;
    // eslint-disable-next-line no-console
    console.log(`[lane D] booking-policy race: ${shape}`);

    const markWon = mark.status === 200;
    expect(pass.failed, shape).toBe(0);

    // EXACTLY ONE FORFEIT, asserted on the money rather than on who won.
    expect(herTransactions('deposit_forfeit') - forfeitsBefore, `forfeited twice: ${shape}`).toBe(1);
    expect(herTransactions('deposit_return'), 'a keep booking wrote a return').toBe(returnsBefore);
    expect(salonRevenue() - revenueBefore, `salon_revenue credited more than once: ${shape}`).toBe(DEPOSIT);
    expect(balanceOf(HER)).toBe(before);
    const row = bookingRow(RACE.id);
    expect(row.status).toBe('no_show_returned');
    expect([row.returned, row.kept]).toEqual([0, DEPOSIT]);

    // And the loser SAYS it lost, rather than silently doing nothing.
    if (markWon) {
      expect(mark.body.keptFils).toBe(DEPOSIT);
      expect(pass.kept, `the mark won and the sweep ALSO kept: ${shape}`).toBe(0);
      expect(pass.alreadySettled, shape).toBeGreaterThanOrEqual(1);
    } else {
      expect(mark.status, shape).toBe(409);
      expect(mark.body.error, shape).toBe('already_no_show');
      expect(pass.kept, `the sweep lost and kept nothing, so who did? ${shape}\n${apiLogTail(30)}`).toBe(1);
      expect(pass.keptFils).toBe(DEPOSIT);
    }
  });

  it('a salon cancel returns the deposit in full, even under `keep` and inside the 0% window', async () => {
    startIn(S_CANCEL.id, 2 * 60);
    const before = balanceOf(HER);
    const revenueBefore = salonRevenue();
    // A key since lane A's f8e1252: the salon's cancel returns money, so #4 applies.
    const res = await treq<any>('POST', `/salons/${SALON}/bookings/${S_CANCEL.id}/cancel`, {
      token: staff,
      idempotencyKey: key('salon-cancel'),
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.refundedFils).toBe(DEPOSIT);
    expect(res.body.booking.policy.noShow, 'the fixture is not a keep booking').toBe('keep');
    expect(res.body.booking.settlement).toEqual({ returnedFils: DEPOSIT, keptFils: 0 });
    expect(balanceOf(HER)).toBe(before + DEPOSIT);
    expect(salonRevenue()).toBe(revenueBefore);
  });

  it('a legacy booking keeps the old full return on her cancel — no key needed — while v3 is current', async () => {
    const before = balanceOf(HER);
    const res = await cancel(L_CANCEL.id);
    expect(res.status, res.raw).toBe(200);
    const result = parsed<any>(BookingCancelResultSchema, res.body, 'the legacy cancel');
    expect(result.booking.policy).toBeNull();
    expect(result.returnPercent).toBe(100);
    expect(result.rule).toBeNull();
    expect([result.refundedFils, result.keptFils]).toEqual([DEPOSIT, 0]);
    expect(result.booking.settlement).toEqual({ returnedFils: DEPOSIT, keptFils: 0 });
    expect(balanceOf(HER)).toBe(before + DEPOSIT);
  });

  it('a deposit_forfeit never reaches the wire: every read that lists her money still answers', async () => {
    precondition(herTransactions('deposit_forfeit') >= 4, 'this file wrote fewer forfeits than it thinks');
    const reads: Array<[string, string]> = [
      ['/members/me/transactions', her],
      ['/bookings', her],
      ['/members/me/notifications/feed', her],
      [`/salons/${SALON}/activity`, staff],
      [`/salons/${SALON}/bookings`, staff],
    ];
    for (const [path, token] of reads) {
      const res = await treq<any>('GET', path, { token });
      expect(res.status, `${path}: ${res.raw.slice(0, 400)}`).toBe(200);
      expect(res.raw.includes('deposit_forfeit'), `${path} serves the forfeit kind`).toBe(false);
    }
  });

  it('LEDGER RECONCILIATION for every booking this file made', () => {
    const problems: string[] = [];
    let keptTotal = 0;
    let returnedTotal = 0;

    for (const id of madeHere) {
      const row = bookingRow(id);
      if (row.status === 'deposit_held') {
        problems.push(`${id} is still held`);
        continue;
      }
      const returned = row.returned ?? NaN;
      const kept = row.kept ?? NaN;
      returnedTotal += returned;
      keptTotal += kept;
      if (returned + kept !== DEPOSIT) problems.push(`${id}: ${returned} + ${kept} is not the ${DEPOSIT} held`);

      // Escrow nets to zero across the hold, the return and the forfeit.
      const escrow = countOf(`
        select coalesce(sum(case when le.direction='credit' then le.amount_fils else -le.amount_fils end), 0)
          from ledger_entry le, booking b
         where b.id = '${id}' and le.account = 'deposit_held'
           and le.transaction_id in (b.hold_transaction_id, b.settled_transaction_id, b.forfeit_transaction_id)`);
      if (escrow !== 0) problems.push(`${id}: deposit_held nets to ${escrow}, not 0`);

      if (kept > 0) {
        const f = scalar(`
          select concat_ws('|', t.kind::text, t.amount_fils::text,
                 (select coalesce(sum(amount_fils), 0) from ledger_entry
                   where transaction_id = t.id and account = 'salon_revenue' and direction = 'credit')::text,
                 (select coalesce(sum(amount_fils), 0) from ledger_entry
                   where transaction_id = t.id and account = 'deposit_held' and direction = 'debit')::text,
                 (select count(*) from ledger_entry where transaction_id = t.id)::text)
            from transaction t where t.id = '${row.forfeitTx}'`);
        const expected = `deposit_forfeit|0|${kept}|${kept}|2`;
        if (f !== expected) problems.push(`${id}: forfeit ${row.forfeitTx} is ${f}, wanted ${expected}`);
      } else if (row.forfeitTx !== null) {
        problems.push(`${id}: nothing kept, yet forfeit ${row.forfeitTx}`);
      }
      if (returned > 0) {
        const r = scalar(`
          select concat_ws('|', t.kind::text, t.amount_fils::text,
                 (select coalesce(sum(amount_fils), 0) from ledger_entry
                   where transaction_id = t.id and account = 'member_wallet' and direction = 'credit')::text)
            from transaction t where t.id = '${row.settledTx}'`);
        const expected = `deposit_return|${returned}|${returned}`;
        if (r !== expected) problems.push(`${id}: return ${row.settledTx} is ${r}, wanted ${expected}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);

    // Her wallet equals her ledger, and the arithmetic of the whole file.
    const walletLedger = countOf(`
      select coalesce(sum(case when direction='credit' then amount_fils else -amount_fils end), 0)
        from ledger_entry where account='member_wallet' and member_id='${HER}'`);
    expect(balanceOf(HER), 'her balance and her wallet ledger disagree').toBe(walletLedger);
    expect(balanceOf(HER)).toBe(OPENING_FILS - madeHere.length * DEPOSIT + returnedTotal);

    // Nothing of hers is left in escrow at all.
    const heldForHer = countOf(`
      select coalesce(sum(case when le.direction='credit' then le.amount_fils else -le.amount_fils end), 0)
        from ledger_entry le join transaction t on t.id = le.transaction_id
       where le.account='deposit_held' and t.member_id='${HER}'`);
    expect(heldForHer).toBe(0);

    // Every forfeited fil is on salon_revenue, and nothing else is.
    expect(salonRevenue(), 'salon_revenue is not the sum of what was kept').toBe(keptTotal);
    // C50, C0, IDEM, K_MARK, K_SWEEP, RACE.
    expect(keptTotal).toBe(HALF_KEPT + DEPOSIT + HALF_KEPT + DEPOSIT + DEPOSIT + DEPOSIT);
  });
});
