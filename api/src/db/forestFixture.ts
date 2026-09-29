/**
 * SAL-FOREST — the dark-green workspace that keeps its own colour on the card.
 *
 * Aftab, 2026-09-29: "if there is a user for a separate workspace and that
 * workspace has a dark green theme chosen then it should override this tier
 * coloring for that workspace. Give me that dark green user credentials so I
 * can show that in a demo."
 *
 * So this workspace is shaped to prove exactly one thing: Maha is GOLD — twelve
 * visits on the default ladder, where gold starts at ten — and her card is still
 * forest green, because the salon chose `walletCard: 'brand'`. Were the salon on
 * `tier`, the same member would carry a gold card. `brandColor` is the token
 * preset `brandPresets.forest` (#1F5A36), which `deriveBrandSet` takes with deep
 * = brand and white at 8.16:1.
 *
 * ONE DEFINITION, TWO CALLERS, and that is why this is a module rather than a
 * block in `seed.ts`:
 *
 *   db/seed.ts         the local fixture world. Dev passwords, and the money
 *                      follows `SEED_RESET` like every other member's.
 *   db/demoForest.ts   the hosted demo database, where the full seed must NEVER
 *                      run (it clears the money tables). Passwords from env,
 *                      and it never rewrites a balance.
 *
 * Two copies of the fixture would drift, and the one that drifted would be the
 * one on the demo. The rows are here; each caller decides only the credentials
 * and what happens to money on a re-run.
 *
 * NO PASSWORD LIVES IN THIS FILE. Both callers pass hashes.
 *
 * WHAT IS DELIBERATELY NOT HERE: artists, a scanner PIN, products, promotions,
 * consent events, bookings. Booking and shop are OFF, the modules' own default,
 * so nothing here needs a roster or a catalogue. `nameAr` is NULL — Arabic copy
 * is written, not invented, and the wallet falls back to "Forest" through
 * `nameAr ?? name` exactly as it does for SAL-LUMIERE.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { fils } from '@avo/types';
import { walletAdjustedPosting } from '../money/ledger';
import { ledgerEntry } from './schema/ledger';
import { member } from './schema/member';
import { branch, salon } from './schema/salon';
import { service } from './schema/service';
import { staffUser } from './schema/staff';
import { transaction } from './schema/transaction';

type ScriptDb = PostgresJsDatabase<Record<string, never>>;
/** The script connection, or a transaction on it. */
export type ForestExecutor = ScriptDb | Parameters<Parameters<ScriptDb['transaction']>[0]>[0];

export const FOREST = {
  salonId: 'SAL-FOREST',
  salonName: 'Forest',
  /** `brandPresets.forest` in design/tokens/avo-tokens.json. */
  brandColor: '#1F5A36',
  branchId: 'BR-FOR-KWC',
  staffId: 'ST-FOR-001',
  staffName: 'Lulwa',
  /** What she types at the dashboard sign-in, with `salonId: 'SAL-FOREST'`. */
  staffHandle: 'forest',
  /**
   * Beside 8842/8843 and far below `member_number_seq` (START WITH 90000), so no
   * signup on any database can ever be handed this id.
   */
  memberId: '8850',
  memberName: 'Maha Al-Rashid',
  /** In the seed's `+965 9912 44xx` run. `member_salon_phone_uq` is per salon. */
  memberPhone: '+96599124450',
  /** 41.750 KD, credited by a real opening entry so the ledger reconciles. */
  openingFils: 41_750,
  /** Gold starts at 10 on the default ladder; 12 is gold with room. */
  visits: 12,
  tier: 'gold',
} as const;

export const FOREST_OPENING_TX = `TX-OPEN-${FOREST.memberId}`;

/**
 * The default ladder, the same four rungs Amara and `DEFAULT_TIERS` in
 * services/salonOnboarding.ts carry.
 */
const FOREST_TIERS = [
  { name: 'bronze' as const, minVisits: 0, bonusPercent: 0 },
  { name: 'silver' as const, minVisits: 4, bonusPercent: 10 },
  { name: 'gold' as const, minVisits: 10, bonusPercent: 20 },
  { name: 'black' as const, minVisits: 20, bonusPercent: 30 },
];

const FOREST_SERVICES = [
  { id: 'SV-FOR-01', name: 'Blow-dry', nameAr: 'تجفيف بالسشوار', priceFils: fils(9000) },
  { id: 'SV-FOR-02', name: 'Manicure', nameAr: 'مانيكير', priceFils: fils(7000) },
];

/**
 * Salon → branch → services → manager, in dependency order, every one an
 * upsert. Nothing is deleted and no money moves.
 *
 * THE CONFLICT BRANCHES REASSERT THE DEMO, unlike Amara's: this workspace
 * exists to show one card, so a re-run puts back the colour, the card choice
 * and the ladder that makes Maha gold, whatever a click-through changed.
 * The manager's `passwordHash` is always restored, for the reason `seed.ts`
 * gives at Noura — the credential a script hands out has to be the one the
 * row holds — and `deactivatedAt` is cleared with it, because
 * `staff_user_deactivated_holds_no_credential` refuses a hash on a leaver.
 */
export async function upsertForestWorkspace(
  db: ForestExecutor,
  hashes: { staffHash: string },
): Promise<void> {
  await db
    .insert(salon)
    .values({
      id: FOREST.salonId,
      name: FOREST.salonName,
      nameAr: null,
      city: 'Kuwait City',
      plan: 'growth',
      brandColor: FOREST.brandColor,
      walletCard: 'brand',
      moduleBooking: false,
      moduleShop: false,
      loyaltyMode: 'tiers',
      tiers: FOREST_TIERS,
      stampTarget: null,
      stampReward: null,
      stampRewardAr: null,
      depositFils: fils(5000),
      noShowReturnMinutes: 60,
      timezone: 'Asia/Kuwait',
      businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
      social: [],
      whatsappEnabled: false,
      emailEnabled: true,
    })
    .onConflictDoUpdate({
      target: salon.id,
      set: {
        name: FOREST.salonName,
        brandColor: FOREST.brandColor,
        walletCard: 'brand',
        loyaltyMode: 'tiers',
        tiers: FOREST_TIERS,
        updatedAt: new Date(),
      },
    });

  await db
    .insert(branch)
    .values({ id: FOREST.branchId, salonId: FOREST.salonId, name: 'Kuwait City', nameAr: 'مدينة الكويت' })
    .onConflictDoUpdate({
      target: branch.id,
      set: { nameAr: sql`excluded.name_ar`, closedAt: null },
    });

  await db
    .insert(service)
    .values(FOREST_SERVICES.map((s) => ({ ...s, salonId: FOREST.salonId })))
    .onConflictDoUpdate({
      target: service.id,
      set: {
        name: sql`excluded.name`,
        nameAr: sql`excluded.name_ar`,
        priceFils: sql`excluded.price_fils`,
        active: true,
      },
    });

  // The manager — every permission, like Noura. No scanner PIN: a PIN is a
  // second secret bound to a device, and the demo is the dashboard and the card.
  const perms = {
    permDashboard: true,
    permAppointments: true,
    permShop: true,
    permLoyalty: true,
    permTeam: true,
    permScanner: true,
    permCharges: true,
    permVoid: true,
    permMarketing: true,
  };
  await db
    .insert(staffUser)
    .values({
      id: FOREST.staffId,
      salonId: FOREST.salonId,
      name: FOREST.staffName,
      handle: FOREST.staffHandle,
      role: 'manager',
      branchAccessAll: true,
      branchAccessIds: [],
      passwordHash: hashes.staffHash,
      ...perms,
    })
    .onConflictDoUpdate({
      target: staffUser.id,
      set: {
        ...perms,
        passwordHash: hashes.staffHash,
        deactivatedAt: null,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
}

/** Maha's row as first written — the values both callers insert. */
export function forestMemberValues(memberHash: string, policyVersion: number) {
  return {
    id: FOREST.memberId,
    salonId: FOREST.salonId,
    name: FOREST.memberName,
    phone: FOREST.memberPhone,
    email: null,
    emailVerified: false,
    passwordHash: memberHash,
    balanceFils: fils(FOREST.openingFils),
    visits: FOREST.visits,
    tier: FOREST.tier,
    stamps: null,
    policyVersion,
  };
}

/**
 * Her opening balance as a REAL credit: an `adjustment` transaction and the
 * console-adjustment ledger pair, built by the same function the API posts
 * with. `seed.ts § the opening balances` argues the kind and the counterpart
 * at length; this is that block's shape for one member.
 *
 * The CALLER decides whether it is owed. Written twice, it would put the
 * ledger 41.750 KD above her balance, and `ledger_entry` is immutable — a
 * duplicate here could never be cleaned up.
 */
export async function writeForestOpeningBalance(db: ForestExecutor): Promise<void> {
  const openedAt = new Date();
  await db.insert(transaction).values({
    id: FOREST_OPENING_TX,
    memberId: FOREST.memberId,
    salonId: FOREST.salonId,
    branchId: FOREST.branchId,
    kind: 'adjustment',
    amountFils: fils(FOREST.openingFils),
    status: 'settled',
    reference: `AVO-OPEN-${FOREST.memberId}`,
    note: 'Opening fixture balance',
    createdAt: openedAt,
    settledAt: openedAt,
  });
  await db.insert(ledgerEntry).values(
    walletAdjustedPosting({
      transactionId: FOREST_OPENING_TX,
      salonId: FOREST.salonId,
      memberId: FOREST.memberId,
      deltaFils: FOREST.openingFils,
      balanceAfterFils: fils(FOREST.openingFils),
    }),
  );
}
