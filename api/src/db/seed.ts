/**
 * Development seed. `pnpm --filter @avo/api run db:seed`
 *
 * Mirrors packages/mock/src/fixtures.ts, because Lane D's e2e suite asserts
 * against those exact values as named constants — Amara, member 8842, 24.500 KD,
 * Silver, ST-001 with every permission and ST-002 with charges and void off.
 * A seed that drifted from the fixtures would make every one of those specs fail
 * for a reason that has nothing to do with the API.
 *
 * Three things exist here that the fixtures do not have:
 *
 *   SAL-LUMIERE   a second salon whose Arabic name columns are NULL, on purpose.
 *                 The client fallback is `nameAr ?? name`, and a row that merely
 *                 LACKS the key proves nothing about it — `undefined ?? name`
 *                 and `null ?? name` agree. Only a genuine NULL can catch a NULL
 *                 arriving at a client as the string "null". See the block
 *                 comment on the insert.
 *
 *   member 8843   a low-balance member (2.500 KD). Lane D pins the insufficient
 *                 balance case with `x-avo-scenario: lowbal`, which the mock
 *                 served by substituting a hardcoded number. A real API cannot
 *                 fabricate a balance without lying about the money, so the
 *                 scenario selects this member instead and the 402 is a real
 *                 shortfall against a real row.
 *
 *   services      the mock kept these in memory. `POST /charges` prices its
 *                 basket from the database, so they have to exist as rows.
 *
 * Idempotent: re-running it resets balances and counters to the fixture values,
 * which is what makes a repeatable test run possible.
 */

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { fils } from '@avo/types';
import { branch, salon } from './schema/salon';
import { artist, type ArtistWindows } from './schema/artist';
import { ledgerEntry } from './schema/ledger';
import { member } from './schema/member';
import { service } from './schema/service';
import { staffUser } from './schema/staff';
import { transaction } from './schema/transaction';
import { hashSecret } from '../auth/password';
import { env } from '../env';

/**
 * The seed connects as the OWNER, not as `avo_app`.
 *
 * Resetting between runs means clearing `ledger_entry`, and the application role
 * has UPDATE and DELETE revoked on it — deliberately, since a ledger you can
 * edit is not a ledger. That the seed needs a different connection to do this is
 * the append-only guarantee working, not an obstacle to route around: nothing
 * the API itself runs can reach these rows.
 */
const connection = postgres(env.databaseUrl, { max: 1 });
const db = drizzle(connection);

const SALON_ID = 'SAL-AMARA';
const BRANCH_SALMIYA = 'BR-SAL';
const BRANCH_KUWAIT_CITY = 'BR-KWC';

/** Development credentials only. Never a default that reaches an environment. */
const MEMBER_PASSWORD = 'dana-dev-password';
const STAFF_PASSWORD = 'noura-dev-password';
const STAFF_PIN = '2468';
const HESSA_PIN = '1357';
const SCANNER_DEVICE = 'DEV-SCANNER-01';

/**
 * A week of availability windows, keyed '0'..'6' JS `getDay()` order.
 *
 * The design fixture (`artistSched` in AVO Merchant Dashboard.dc.html) stores
 * minutes past midnight — 600, 1260 — because its steppers do arithmetic on
 * them. The contract stores "HH:mm". Converting here rather than storing minutes
 * keeps the database holding the contract's shape, and keeps the two
 * representations from both being half-true.
 *
 * Days not named are CLOSED, and still carry a from/to. A closed day with no
 * times cannot be reopened by ticking one box — the dashboard's steppers need
 * something to start from, which is why the schema keeps the values and only the
 * `open` flag decides anything. Friday is closed everywhere in the fixture; it
 * is the Kuwaiti weekend day, not an oversight.
 */
function week(open: Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', [number, number]>>): ArtistWindows {
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const out: ArtistWindows = {};
  order.forEach((name, index) => {
    const span = open[name];
    out[String(index)] = span
      ? { open: true, from: hhmm(span[0]), to: hhmm(span[1]) }
      : { open: false, from: '10:00', to: '21:00' };
  });
  return out;
}

async function seed(): Promise<void> {
  const [memberHash, staffHash, pinHash, hessaPinHash] = await Promise.all([
    hashSecret(MEMBER_PASSWORD),
    hashSecret(STAFF_PASSWORD),
    hashSecret(STAFF_PIN),
    hashSecret(HESSA_PIN),
  ]);

  await db
    .insert(salon)
    .values({
      id: SALON_ID,
      name: 'Amara',
      // From design/avo-promotions.js, the bundle's own reference implementation
      // — not a translation invented here. `branchLabel()` in that file picks
      // `nameAr` when the language is `ar`, so these are the exact strings the
      // design already demonstrates the wallet rendering.
      nameAr: 'أمارا',
      plan: 'growth',
      brandColor: '#6E7F6C',
      moduleBooking: false,
      moduleShop: false,
      loyaltyMode: 'tiers',
      tiers: [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 4, bonusPercent: 10 },
        { name: 'gold', minVisits: 10, bonusPercent: 20 },
        { name: 'black', minVisits: 20, bonusPercent: 30 },
      ],
      stampTarget: 8,
      stampReward: 'Free blow-dry',
      stampRewardAr: 'تصفيف شعر مجاني',
      depositFils: fils(5000),
      noShowReturnMinutes: 60,
      businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
      social: [
        { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
        { id: 'tiktok', label: 'TikTok', handle: '@amara.kw', on: true },
        { id: 'snapchat', label: 'Snapchat', handle: '', on: false },
        { id: 'whatsapp', label: 'WhatsApp', handle: '+96522334455', on: true },
      ],
      whatsappEnabled: true,
    })
    // NOT `onConflictDoNothing()`, and the difference is the whole point of the
    // change that introduced these two columns. Every developer and CI database
    // already holds an Amara row from an earlier run, so DO NOTHING would leave
    // `name_ar` NULL there for ever and the seed would silently claim to have
    // written a translation it did not write — the same class of failure the
    // member rows below document for `passwordHash`.
    //
    // Only the Arabic columns are in the SET. The rest of Amara's configuration
    // is left alone deliberately: it is a salon a developer may have edited
    // through `PATCH /salons/:id` while working, and this insert is not the
    // place that resets it.
    .onConflictDoUpdate({
      target: salon.id,
      set: { nameAr: 'أمارا', stampRewardAr: 'تصفيف شعر مجاني' },
    });

  await db
    .insert(branch)
    .values([
      { id: BRANCH_SALMIYA, salonId: SALON_ID, name: 'Salmiya', nameAr: 'السالمية' },
      { id: BRANCH_KUWAIT_CITY, salonId: SALON_ID, name: 'Kuwait City', nameAr: 'مدينة الكويت' },
    ])
    // Same reasoning as the salon above: existing branch rows must actually
    // receive the Arabic names, not silently keep a NULL from an earlier run.
    .onConflictDoUpdate({
      target: branch.id,
      set: { nameAr: sql`excluded.name_ar` },
    });

  // ------------------------------------------------- the salon that has none --
  //
  // LUMIÈRE EXISTS HERE TO HOLD A REAL NULL.
  //
  // The Arabic fields fall back on the client with `nameAr ?? name`, and that
  // fallback is untestable against a row that simply lacks the key: `undefined
  // ?? name` and `null ?? name` give the same answer, which is precisely how the
  // missing implementation went unnoticed in the first place. The failure it
  // cannot see is the stringify bug — a NULL reaching a client as the FOUR
  // CHARACTER STRING "null", which renders as a salon called null and satisfies
  // `??` perfectly. Only a row that genuinely holds NULL can catch that.
  //
  // So this salon is seeded with `nameAr` and `stampRewardAr` left NULL
  // DELIBERATELY. It is not an oversight to be tidied up later, and a future
  // seed must not "complete" it.
  //
  // WHY THESE PARTICULAR VALUES
  // ---------------------------
  // `e2e/support/tenancy-harness.ts` (lane D) also seeds SAL-LUMIERE, with
  // `ON CONFLICT (id) DO NOTHING`, as does this insert — so whichever runs first
  // wins and the other is a no-op. The fields below are therefore kept
  // BYTE-IDENTICAL to that harness's INSERT, so the winner is irrelevant. The
  // only additions are the two Arabic columns, which the harness's insert omits
  // and which therefore arrive as NULL from it too: both paths produce the same
  // row. If lane D's fixture ever changes, this must change with it.
  await db
    .insert(salon)
    .values({
      id: 'SAL-LUMIERE',
      name: 'Lumiere',
      nameAr: null,
      plan: 'starter',
      brandColor: '#7A5C8E',
      moduleBooking: false,
      moduleShop: false,
      loyaltyMode: 'tiers',
      tiers: [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 4, bonusPercent: 10 },
      ],
      stampTarget: null,
      stampReward: null,
      stampRewardAr: null,
      depositFils: fils(5000),
      noShowReturnMinutes: 60,
      businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
      social: [],
      whatsappEnabled: false,
    })
    .onConflictDoNothing();

  await db
    .insert(branch)
    .values([
      { id: 'BR-LUM-HAW', salonId: 'SAL-LUMIERE', name: 'Hawally', nameAr: null },
      { id: 'BR-LUM-JAB', salonId: 'SAL-LUMIERE', name: 'Jabriya', nameAr: null },
    ])
    .onConflictDoNothing();

  await db
    .insert(service)
    .values([
      { id: 'SV-01', salonId: SALON_ID, name: 'Blow-dry', priceFils: fils(8000) },
      { id: 'SV-02', salonId: SALON_ID, name: 'Cut & style', priceFils: fils(15000) },
      { id: 'SV-03', salonId: SALON_ID, name: 'Colour — roots', priceFils: fils(25000) },
      { id: 'SV-04', salonId: SALON_ID, name: 'Manicure', priceFils: fils(6000) },
      { id: 'SV-05', salonId: SALON_ID, name: 'Treatment', priceFils: fils(12500) },
    ])
    .onConflictDoNothing();

  // ------------------------------------------------------------- artists ----
  //
  // The four artists of design/AVO Merchant Dashboard.dc.html § Team, with the
  // weeks its `artistSched` fixture holds, converted from minutes-past-midnight
  // to the contract's "HH:mm". Two are Google-sourced and two manual, because
  // the read-only refusal in PUT /artists/{id}/availability is only provable
  // against a row that is actually synced.
  //
  // AR-003 is Hessa, and she is the only one wired to a `staff_user`. She holds
  // a scanner PIN (ST-002), so she is the fixture that makes
  // `PUT /artists/me/availability` reachable — and, because ST-002 is the
  // deliberately restricted account with `perms.team` OFF, she is simultaneously
  // the proof that own-hours needs no team authority and that the same body sent
  // at somebody else's id is refused.
  await db
    .insert(artist)
    .values([
      {
        id: 'AR-001',
        salonId: SALON_ID,
        name: 'Rana Al-Sabah',
        nameAr: 'رنا الصباح',
        // Google-sourced: windows are read-only until switched to manual.
        availabilitySource: 'google',
        googleConnected: true,
        slotMinutes: 30,
        windows: week({ sun: [600, 1260], mon: [600, 1260], tue: [600, 1260], wed: [600, 1260], thu: [600, 1260], sat: [960, 1260] }),
      },
      {
        id: 'AR-002',
        salonId: SALON_ID,
        name: 'Dana Yousef',
        nameAr: 'دانة يوسف',
        availabilitySource: 'google',
        googleConnected: true,
        slotMinutes: 45,
        windows: week({ sun: [600, 1260], tue: [660, 1260], wed: [600, 1260], thu: [600, 1200] }),
      },
      {
        id: 'AR-003',
        salonId: SALON_ID,
        staffUserId: 'ST-002',
        name: 'Hessa M.',
        nameAr: 'حصة م.',
        availabilitySource: 'manual',
        // Connected but manual — the normal state after reception takes the
        // wheel, and the combination the CHECK deliberately permits.
        googleConnected: true,
        slotMinutes: 30,
        windows: week({ sun: [600, 1260], mon: [600, 1260], tue: [600, 1260], wed: [600, 1260], thu: [600, 1260] }),
      },
      {
        id: 'AR-004',
        salonId: SALON_ID,
        name: 'Shaikha B.',
        // No Arabic name and no Google connection: the null-fallback row, and
        // the one that proves switching TO google is refused without a calendar.
        nameAr: null,
        availabilitySource: 'manual',
        googleConnected: false,
        slotMinutes: 60,
        windows: week({ sun: [960, 1260], mon: [960, 1260], thu: [960, 1260], sat: [960, 1260] }),
      },
    ])
    .onConflictDoUpdate({
      target: artist.id,
      // Re-running resets the availability state, so a spec that switched AR-001
      // to manual does not leave the next run without a synced fixture.
      set: {
        availabilitySource: sql`excluded.availability_source`,
        googleConnected: sql`excluded.google_connected`,
        slotMinutes: sql`excluded.slot_minutes`,
        windows: sql`excluded.windows`,
        active: true,
      },
    });

  // Dana — the fixture member. 24.500 KD, 5 visits, Silver.
  await db
    .insert(member)
    .values({
      id: '8842',
      salonId: SALON_ID,
      name: 'Dana Al-Sabah',
      phone: '+96599124408',
      email: 'dana@example.com',
      emailVerified: true,
      passwordHash: memberHash,
      // 32.500 here, not 24.500: the TX-9021 charge posted at the bottom of this
      // file debits 8.000 and lands her on the fixture balance, with a ledger
      // that reconciles to it.
      balanceFils: fils(32500),
      visits: 6,
      tier: 'silver',
      stamps: null,
      policyVersion: 3,
    })
    .onConflictDoUpdate({
      target: member.id,
      // Reset to the pre-charge values so a suite run starts from a known state.
      //
      // `passwordHash` is reset too, and it is not decoration. Without it, the
      // upsert branch left whatever hash the FIRST seed of this database wrote,
      // so re-seeding restored the balance and the tier but not the credential
      // — and the script then printed "member 8842 / dana-dev-password" and
      // meant it, while `POST /auth/member/session` answered 401. A fixture
      // that prints credentials it does not actually restore is worse than one
      // that prints nothing: it sends you looking for the bug in the auth code.
      set: {
        balanceFils: fils(32500),
        visits: 6,
        tier: 'silver',
        stamps: null,
        passwordHash: memberHash,
      },
    });

  // The low-balance member behind `x-avo-scenario: lowbal`. 2.500 KD.
  await db
    .insert(member)
    .values({
      id: '8843',
      salonId: SALON_ID,
      name: 'Reem Al-Fahad',
      phone: '+96599124409',
      email: null,
      emailVerified: false,
      passwordHash: memberHash,
      balanceFils: fils(2500),
      visits: 1,
      tier: 'bronze',
      stamps: null,
      policyVersion: 3,
    })
    .onConflictDoUpdate({
      target: member.id,
      set: {
        balanceFils: fils(2500),
        visits: 1,
        tier: 'bronze',
        stamps: null,
        passwordHash: memberHash,
      },
    });

  // ST-001 Noura — manager, every permission.
  await db
    .insert(staffUser)
    .values({
      id: 'ST-001',
      salonId: SALON_ID,
      name: 'Noura',
      handle: 'noura',
      role: 'manager',
      branchAccessAll: true,
      branchAccessIds: [],
      passwordHash: staffHash,
      pinHash,
      pinDeviceId: SCANNER_DEVICE,
      permDashboard: true,
      permAppointments: true,
      permShop: true,
      permLoyalty: true,
      permTeam: true,
      permScanner: true,
      permCharges: true,
      permVoid: true,
      permMarketing: true,
    })
    .onConflictDoUpdate({
      target: staffUser.id,
      set: {
        permDashboard: true,
        permAppointments: true,
        permShop: true,
        permLoyalty: true,
        permTeam: true,
        permScanner: true,
        permCharges: true,
        permVoid: true,
        permMarketing: true,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        // Same reasoning as the member above: the credentials this script
        // prints have to be the credentials the row actually holds.
        passwordHash: staffHash,
        pinHash,
        pinDeviceId: SCANNER_DEVICE,
      },
    });

  // ST-002 Hessa — frontdesk, deliberately restricted. This is the account Lane
  // B and Lane D use to prove the locked screen and the 403. Scanner stays ON:
  // she can take payment, she just cannot review or reverse one.
  await db
    .insert(staffUser)
    .values({
      id: 'ST-002',
      salonId: SALON_ID,
      name: 'Hessa',
      handle: 'hessa',
      role: 'frontdesk',
      branchAccessAll: false,
      branchAccessIds: [BRANCH_SALMIYA],
      passwordHash: staffHash,
      pinHash: hessaPinHash,
      pinDeviceId: SCANNER_DEVICE,
      permDashboard: false,
      permAppointments: true,
      permShop: false,
      permLoyalty: false,
      permTeam: false,
      permScanner: true,
      permCharges: false,
      permVoid: false,
      permMarketing: false,
    })
    .onConflictDoUpdate({
      target: staffUser.id,
      set: {
        permDashboard: false,
        permAppointments: true,
        permShop: false,
        permLoyalty: false,
        permTeam: false,
        permScanner: true,
        permCharges: false,
        permVoid: false,
        permMarketing: false,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        passwordHash: staffHash,
        pinHash: hessaPinHash,
        pinDeviceId: SCANNER_DEVICE,
      },
    });

  // Clear the transient money-path state so a run is repeatable.
  //
  // `ledger_entry` is immutable: the application role has UPDATE and DELETE
  // revoked, AND a trigger raises on both so that even the owner cannot remove a
  // row by accident. Migration 0001 says so explicitly — "removing a row then
  // takes deliberately disabling a trigger, which is a DDL event rather than a
  // typo". This is that deliberate act, and it is the only place in the
  // repository that performs it. It is guarded by the production check at the
  // bottom of this file.
  // `gateway_event` is append-only for the same reason and by the same means
  // (migration 0004), so clearing it takes the same deliberate act.
  await db.execute(sql`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_is_immutable`);
  await db.execute(sql`ALTER TABLE gateway_event DISABLE TRIGGER gateway_event_no_delete`);
  try {
    await db.execute(sql`DELETE FROM receipt_job`);
    await db.execute(sql`DELETE FROM ledger_entry`);
    await db.execute(sql`DELETE FROM idempotency_key`);
    await db.execute(sql`DELETE FROM wallet_token`);
    // Order follows the restricting references: event → intent → transaction.
    await db.execute(sql`DELETE FROM gateway_event`);
    await db.execute(sql`DELETE FROM topup_intent`);
    await db.execute(sql`DELETE FROM sandbox_gateway_payment`);
    // `loyalty_event.transaction_id` is ON DELETE RESTRICT, so the climbs a
    // charge produced have to go before the charge does.
    await db.execute(sql`DELETE FROM loyalty_event`);
    await db.execute(sql`DELETE FROM transaction`);
    await db.execute(sql`DELETE FROM session`);
    await db.execute(sql`DELETE FROM pin_attempt`);
  } finally {
    await db.execute(sql`ALTER TABLE gateway_event ENABLE TRIGGER gateway_event_no_delete`);
    await db.execute(sql`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_is_immutable`);
  }

  // ------------------------------------------------------------ TX-9021 ----
  //
  // Lane D's permission specs void `TX-9021` by name and assert it is a settled
  // −8.000 charge in Dana's feed. It is a mock fixture id, so a real database has
  // no counterpart unless one is made — and making one carelessly would leave a
  // money row with no ledger behind it, which is exactly the state `ledger_entry`
  // exists to prevent.
  //
  // So it is seeded the way the API would have written it: Dana is inserted at
  // 32.500, the charge posts a balanced pair of entries, and her balance lands on
  // the 24.500 the fixtures specify. The ledger reconciles to the balance, and
  // `SELECT sum(...) FROM ledger_entry` still recomputes the wallet from first
  // principles.
  //
  // It is dated now rather than backdated so it sits inside the 15-minute void
  // window; a two-day-old charge is not voidable, it is a reimbursement.
  const chargedAt = new Date();
  await db.insert(transaction).values({
    id: 'TX-9021',
    memberId: '8842',
    salonId: SALON_ID,
    branchId: BRANCH_SALMIYA,
    kind: 'charge',
    amountFils: fils(-8000),
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9021',
    createdByStaffId: 'ST-001',
    createdAt: chargedAt,
    settledAt: chargedAt,
  });
  await db.insert(ledgerEntry).values([
    {
      transactionId: 'TX-9021',
      salonId: SALON_ID,
      memberId: '8842',
      account: 'member_wallet',
      direction: 'debit',
      amountFils: fils(8000),
      balanceAfterFils: fils(24500),
    },
    {
      transactionId: 'TX-9021',
      salonId: SALON_ID,
      memberId: null,
      account: 'salon_revenue',
      direction: 'credit',
      amountFils: fils(8000),
    },
  ]);
  // The charge lands her on the fixture balance and visit count.
  await db
    .update(member)
    .set({ balanceFils: fils(24500), visits: 5 })
    .where(eq(member.id, '8842'));

  console.log('seeded');
  console.log(`  member  8842 / ${MEMBER_PASSWORD}   (24.500 KD, Silver)`);
  console.log(`  member  8843 / ${MEMBER_PASSWORD}   (2.500 KD — the lowbal scenario)`);
  console.log(`  web     noura / ${STAFF_PASSWORD}`);
  console.log(`  PIN     noura ${STAFF_PIN} · hessa ${HESSA_PIN} on device ${SCANNER_DEVICE}`);
}

// This script truncates the money tables and disables an immutability trigger to
// do it. It must never be a thing that can be run against real customer money.
if (env.nodeEnv === 'production') {
  throw new Error('The seed resets balances and clears the ledger. It cannot run in production.');
}

try {
  await seed();
} finally {
  await connection.end();
}
