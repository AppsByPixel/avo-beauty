/**
 * `describeTransaction` / `describeLoyalty` — THE SWITCH WITH ARITHMETIC IN IT AND NO
 * TEST AT ANY LAYER.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run activity-feed.test.ts
 *
 * WHAT WAS UNCOVERED, AND HOW COMPLETELY
 * --------------------------------------
 * `api/src/services/activityFeed.ts` composes the sentence on every line of both
 * activity feeds. `describeTransaction` is a five-case switch over `FEED_KINDS`, each
 * case composing different prose; `topup` sub-branches on `bonusFils > 0` and on
 * `METHOD_LABEL[row.method]` and does ARITHMETIC — `row.amountFils - row.bonusFils`;
 * `adjustment` sub-branches on `reversesTransactionId`. `describeLoyalty` branches on
 * `tier_climb` against the stamp path and computes a tier-DESCENT comparison by
 * indexing a hardcoded ladder.
 *
 * Before this file there was no `activityFeed` test file anywhere in the repository —
 * a `find` for `activityFeed*.test.ts` outside `node_modules` returned nothing — and no assertion on the `what` field on any surface. Grepping the output
 * strings ("topped up", "deposit returned", "bought from the shop", "charge voided",
 * "wallet adjusted", "reached … tier", "filled the stamp card") found no hits outside
 * the service itself. `e2e/contract.test.ts` checks the two feeds' ENVELOPE and says
 * so; `apps/wallet/src/domain/activity.test.ts` tests the wallet client's own
 * separate `toActivityRow`, which is a different function on a different shape.
 *
 * So: a per-case switch, with per-case arithmetic, consumed by two endpoints, and
 * nothing anywhere asserted a single one of its sentences.
 *
 * WHY THE ARITHMETIC IS THE PART THAT MATTERS
 * -------------------------------------------
 * The file's own header flags it as a defect that was already found and fixed once:
 * a top-up's `amount_fils` is "what actually landed, bonus included", so printing the
 * column reads "topped up 30.000 · +5.000 bonus" and "tells a merchant her customer
 * paid five dinars she did not". `- row.bonusFils` is the fix. Nothing was guarding
 * it, which means the fix was one careless edit from being undone in the one place
 * where — the header again — "the reader is AVO rather than the salon and cannot
 * check it against a receipt".
 *
 * AND WRITING THAT GUARD FOUND THE SAME DEFECT ONE COLUMN OVER. See § THE SECOND
 * BONUS COLUMN. `services/topup.ts` writes `transaction.amountFils = intent.creditFils`,
 * and `credit = amountFils + bonus + promoBonus` — so `amount_fils` includes the
 * PROMOTION bonus too, and `describeTransaction` subtracts only `bonusFils`. A
 * happy-hour top-up therefore reports a figure the customer never paid, by exactly
 * the promo bonus, with the promo bonus itself invisible. That is filed as a
 * `knownBug()` rather than fixed here, because `api/` is lane A's column.
 *
 * DERIVED FROM THE CONSTANTS, NOT ENUMERATED HERE
 * ----------------------------------------------
 * `e2e/campaigns.test.ts` § THE AUDIENCE DIMENSION is the model and carries the full
 * argument. Four constants are read out of lane A's source as text, by
 * `support/source-enums.ts`, each cross-checked against the artifact that is actually
 * deployed:
 *
 *   FEED_KINDS      services/activityFeed.ts, an `as const` array — cross-checked
 *                   against the `transaction_kind` Postgres enum, which is what the
 *                   feed's `inArray` filter runs against.
 *   loyaltyEventKind  db/schema/loyaltyEvent.ts, a pgEnum — cross-checked against
 *                   `pg_enum` AND against the CHECK constraint that decides which
 *                   kinds are writable at all.
 *   METHOD_LABEL    services/activityFeed.ts, a Record — cross-checked against the
 *                   `payment_method` enum, because `METHOD_LABEL[row.method] ??
 *                   row.method` puts a raw database value in front of a merchant for
 *                   any method the map has not heard of.
 *   TIER_LABEL      the same, against `tier_name`, plus `describeLoyalty`'s own local
 *                   `order` ladder — a tier missing from THAT array makes `indexOf`
 *                   return -1 and a climb read as a descent.
 *
 * WHAT A DERIVED LOOP CAN HONESTLY ASSERT, AND WHERE THE EXACT STRINGS LIVE
 * ------------------------------------------------------------------------
 * The whole point of a per-case switch is that each case says something different, so
 * a loop cannot know the sentence. What a loop CAN say is the thing that actually
 * breaks when a case is missing: that the sentence is not the `default:` arm.
 * `describeTransaction` ends `return \`${row.kind} ${amount}\``, so a sixth feed kind
 * added to `FEED_KINDS` without a case renders "deposit_hold 5.000" — a raw enum
 * value and a bare number, on a merchant's Overview. § EVERY FEED KIND asserts that
 * for every kind, derived, and it is the assertion that would fire on the day this
 * class of bug recurs here.
 *
 * `describeLoyalty` has no default arm at all — it is `if (tier_climb) … else stamp`
 * — so a third loyalty kind would silently render "filled the stamp card · 0 of 0".
 * § EVERY LOYALTY KIND asserts the sentences are mutually distinct, which is what
 * catches that.
 *
 * The exact strings are in the named specs under § THE SENTENCES, THEMSELVES, one per
 * branch, where the reasoning for each can be written beside it. A completeness spec
 * requires those named specs to cover every kind the constant declares, so a sixth
 * kind fails BY NAME asking for its sentence rather than quietly going uncovered.
 *
 * ROWS WRITTEN AS FIXTURES, WHICH IS THE ONLY WAY TO SEE THIS FUNCTION AT ALL
 * --------------------------------------------------------------------------
 * `describeTransaction` is pure and `e2e/` does not import from `api/src`, so its
 * output is observable only through the wire. Driving each case through its real
 * money path instead would mean a gateway top-up, a charge, a void, a deposit return
 * and a shop order per case — five suites' worth of setup — and would still not reach
 * `bonusFils = 0` with a method, or an `adjustment` with no reversal, or a
 * `deposit_return` with no note. Those are the sub-branches. So the rows are inserted
 * directly and read back through both endpoints, exactly as `configuration.test.ts`
 * inserts an artist to make the Team section assertable. The money PATHS that produce
 * these rows are `money.test.ts`, `deposit.test.ts`, `orders.test.ts` and
 * `adjustments.test.ts`; this file is about the sentence, and only about the sentence.
 *
 * A MEMBER AND TRANSACTIONS OF THIS FILE'S OWN, ALL PREFIXED, ALL REMOVED IN
 * `afterAll`. Nothing here touches Fatima (`9001`) or any existing row: salon B's
 * revenue is something `reports.test.ts` reads later in the same run, and a suite
 * that left thirty settled transactions behind would move it.
 *
 * BOTH ENDPOINTS, EVERY TIME. `GET /salons/{id}/activity` and
 * `GET /v1/platform/activity` call the SAME two functions, and the service header
 * says that is the property it exists to hold: "a `kind` chip that means something
 * slightly different on the console than on the dashboard… turns 'these two screens
 * disagree' into a question about the record itself." So every derived loop asserts
 * the two surfaces produce a byte-identical `what` for the same row. That is a claim
 * only a suite that can reach both principals can make, and it is cheap here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { knownBug, precondition } from './support/known-bug.js';
import {
  constArrayFromSource,
  constraintDef,
  localArrayFromSource,
  pgEnumFromSource,
  pgEnumLabels,
  quotedStrings,
  stringRecordFromSource,
} from './support/source-enums.js';
import {
  B_BRANCH,
  B_STAFF,
  B_STAFF_HANDLE,
  PLATFORM_OWNER_HANDLE,
  SALON_B,
  psql,
  repoRoot,
  scalar,
  signInDashboard,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

let dashboard = '';
let platform = '';

const FEED_SERVICE_FILE = join(repoRoot, 'api', 'src', 'services', 'activityFeed.ts');
const LOYALTY_SCHEMA_FILE = join(repoRoot, 'api', 'src', 'db', 'schema', 'loyaltyEvent.ts');

// --------------------------------------------------------- the constants, read --

const FEED_KINDS = constArrayFromSource(FEED_SERVICE_FILE, 'FEED_KINDS');
const LOYALTY_ENUM = pgEnumFromSource(LOYALTY_SCHEMA_FILE, 'loyaltyEventKind');
const LOYALTY_KINDS = LOYALTY_ENUM.values;
const METHOD_LABEL = stringRecordFromSource(FEED_SERVICE_FILE, 'METHOD_LABEL');
const TIER_LABEL = stringRecordFromSource(FEED_SERVICE_FILE, 'TIER_LABEL');
/** `describeLoyalty`'s own ladder, which the descent comparison indexes into. */
const TIER_ORDER = localArrayFromSource(FEED_SERVICE_FILE, 'order');

// ------------------------------------------------------------------- fixtures --

const MEMBER = 'QA-FEED-0001';
const MEMBER_NAME = 'Sara Al-Muhanna';
const MEMBER_PHONE = '+96599666401';

const tx = (label: string): string => `TX-QA-FEED-${label}`;
/** Fixed v4-shaped uuids, so a loyalty row can be found by id rather than by prose. */
const le = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * `kd()`, reimplemented rather than imported, because `e2e/` does not import from
 * `api/src`. THREE DECIMALS AND ABSOLUTE, which is non-negotiable #1's display
 * boundary and is also why a charge stored as `-12000` reads "paid 12.000" rather
 * than "paid -12.000".
 */
const kd = (fils: number): string => (Math.abs(fils) / 1000).toFixed(3);

interface TxFixture {
  label: string;
  kind: string;
  amountFils: number;
  bonusFils?: number;
  promoBonusFils?: number;
  method?: string;
  note?: string;
  reverses?: string;
  staff?: string;
}

/**
 * A signed amount per feed kind, and the completeness of THIS MAP is asserted by a
 * spec rather than assumed.
 *
 * WHY IT IS NOT DERIVED. `transaction_amount_sign_matches_kind` fixes the sign per
 * kind — `topup`/`deposit_return` positive, `charge` non-positive, `deposit_hold`/
 * `shop` negative, `adjustment` non-zero — and a fixture that guessed wrong is
 * refused by the database, not by a spec. Deriving the sign would mean parsing
 * `pg_get_constraintdef()`'s SQL expression, which is a parser with no cross-check of
 * its own and would fail silently in the one direction that matters.
 *
 * So the map is written out, and `amountForKind()` below THROWS on a kind it has no
 * entry for — at collection time, before `beforeAll` has inserted anything. That
 * ordering is the point: a `?? 1_000` default would be a POSITIVE amount, which
 * `transaction_amount_sign_matches_kind` refuses for every debit kind, so the file
 * would die in `beforeAll` with a raw constraint violation and no clue what to do.
 * The throw names the kind and says what to add. § the derivation itself asserts the
 * same completeness where a reader looks for it.
 */
const AMOUNT_FOR_KIND: Record<string, number> = {
  topup: 25_000,
  charge: -12_000,
  deposit_return: 5_000,
  shop: -9_500,
  adjustment: 3_000,
};

/**
 * `staff` ON EVERY ONE OF THEM, AND THAT IS LOAD-BEARING RATHER THAN TIDY. The two
 * route handlers special-case `kind === 'deposit_return' && createdByStaffId === null`
 * and compose that line THEMSELVES, outside `describeTransaction` — so a
 * `deposit_return` fixture with no staff would take the route's branch and this loop
 * would silently stop testing the service for that kind. The System line has its own
 * spec, with its own row, under § THE SENTENCES.
 */
const amountForKind = (kind: string): number => {
  const amount = AMOUNT_FOR_KIND[kind];
  if (amount === undefined) {
    throw new Error(
      `FEED_KINDS contains "${kind}" and AMOUNT_FOR_KIND in e2e/activity-feed.test.ts has ` +
        'no signed amount for it.\nAdd one whose SIGN `transaction_amount_sign_matches_kind` ' +
        `permits for "${kind}", and give the kind an exact sentence under § THE SENTENCES, ` +
        'THEMSELVES. Thrown here rather than defaulted, because a default would be refused ' +
        'by that CHECK during seeding and the failure would arrive as a raw constraint ' +
        'violation instead of this message.',
    );
  }
  return amount;
};

const KIND_ROWS: TxFixture[] = FEED_KINDS.map((kind) => ({
  label: `KIND-${kind.toUpperCase()}`,
  kind,
  amountFils: amountForKind(kind),
  staff: B_STAFF,
  ...(kind === 'topup' ? { method: 'knet' } : {}),
}));

/** One settled top-up per payment method, for the `METHOD_LABEL` loop. */
const METHOD_ROWS: TxFixture[] = Object.keys(METHOD_LABEL).map((method) => ({
  label: `METHOD-${method.toUpperCase()}`,
  kind: 'topup',
  amountFils: 10_000,
  method,
}));

/** The named sub-branch rows. Each is referenced by exactly one spec below. */
const BRANCH_ROWS: TxFixture[] = [
  // topup — the arithmetic, and the two sides of `bonusFils > 0`.
  { label: 'TOPUP-BONUS', kind: 'topup', amountFils: 30_000, bonusFils: 5_000, method: 'knet' },
  { label: 'TOPUP-PLAIN', kind: 'topup', amountFils: 25_000, method: 'card' },
  { label: 'TOPUP-NOMETHOD', kind: 'topup', amountFils: 20_000 },
  {
    label: 'TOPUP-PROMO',
    kind: 'topup',
    amountFils: 27_000,
    bonusFils: 0,
    promoBonusFils: 2_000,
    method: 'knet',
  },

  // charge — including migration 0014's legitimate zero.
  { label: 'CHARGE', kind: 'charge', amountFils: -12_000, staff: B_STAFF },
  { label: 'CHARGE-ZERO', kind: 'charge', amountFils: 0, staff: B_STAFF },
  { label: 'CHARGE-VOIDABLE', kind: 'charge', amountFils: -8_000, staff: B_STAFF },

  // deposit_return — the note branch, and the System line the ROUTE composes.
  {
    label: 'DEPRET-NOTE',
    kind: 'deposit_return',
    amountFils: 5_000,
    note: 'Aisha M. no-show',
    staff: B_STAFF,
  },
  { label: 'DEPRET-NONOTE', kind: 'deposit_return', amountFils: 5_000, staff: B_STAFF },
  { label: 'DEPRET-SYSTEM', kind: 'deposit_return', amountFils: 4_000 },

  { label: 'SHOP', kind: 'shop', amountFils: -9_500, staff: B_STAFF },

  // adjustment — both sides of `reversesTransactionId`, and both signs of the one
  // that is not a reversal.
  {
    label: 'VOID-NOTE',
    kind: 'adjustment',
    amountFils: 12_000,
    reverses: tx('CHARGE'),
    note: 'wrong service rung up',
    staff: B_STAFF,
  },
  { label: 'VOID-NONOTE', kind: 'adjustment', amountFils: 8_000, reverses: tx('CHARGE-VOIDABLE') },
  { label: 'ADJ-POS', kind: 'adjustment', amountFils: 3_000, note: 'goodwill credit' },
  { label: 'ADJ-NEG', kind: 'adjustment', amountFils: -3_000 },
];

const ALL_TX: TxFixture[] = [...KIND_ROWS, ...METHOD_ROWS, ...BRANCH_ROWS];

interface LoyaltyFixture {
  n: number;
  kind: string;
  fromTier?: string;
  toTier?: string;
  stampsAfter?: number;
  stampTarget?: number;
}

/**
 * One climb per tier, with `fromTier` the rung BELOW it — derived from the ladder, so
 * a tier added to `tier_name` gets a spec. The lowest rung climbs from nothing, which
 * is the `fromTier === null` branch ("a member who was on no tier yet").
 */
const climbFor = (tier: string): LoyaltyFixture => {
  const i = TIER_ORDER.indexOf(tier);
  return {
    n: 100 + Math.max(i, 0),
    kind: 'tier_climb',
    ...(i > 0 ? { fromTier: TIER_ORDER[i - 1] as string } : {}),
    toTier: tier,
  };
};

const LOYALTY_ROWS: LoyaltyFixture[] = [
  // The descent, which is the comparison nothing had ever driven.
  { n: 1, kind: 'tier_climb', fromTier: 'gold', toTier: 'bronze' },
  { n: 2, kind: 'stamp_reward_ready', stampsAfter: 6, stampTarget: 6 },
  { n: 3, kind: 'stamp_reward_ready', stampsAfter: 0, stampTarget: 0 },
  ...TIER_ORDER.map(climbFor),
];

const sqlStr = (v: string | undefined): string => (v === undefined ? 'NULL' : `'${v}'`);
const sqlNum = (v: number | undefined): string => (v === undefined ? 'NULL' : String(v));

function seedFeed(): void {
  const txValues = ALL_TX.map(
    (r, i) =>
      `('${tx(r.label)}', '${MEMBER}', '${SALON_B}', '${B_BRANCH}', false, '${r.kind}', ` +
      `${r.amountFils}, ${r.bonusFils ?? 0}, ${r.promoBonusFils ?? 0}, ` +
      `${sqlStr(r.method)}::payment_method, 'settled', '', ${sqlStr(r.note)}, ` +
      `${sqlStr(r.reverses)}, ${sqlStr(r.staff)}, ` +
      `now() - (${i} * interval '1 millisecond'), now())`,
  );

  const loyaltyValues = LOYALTY_ROWS.map(
    (r, i) =>
      `('${le(r.n)}', '${SALON_B}', '${MEMBER}', '${r.kind}', ` +
      `${sqlStr(r.fromTier)}::tier_name, ${sqlStr(r.toTier)}::tier_name, ` +
      `${sqlNum(r.stampsAfter)}, ${sqlNum(r.stampTarget)}, ` +
      `now() - (${i} * interval '1 millisecond'))`,
  );

  psql(`
BEGIN;

-- The member every fixture row belongs to. password_hash is copied from a STAFF row
-- for the reason seedSalonB() gives: hashSecret() is one function for both, so the
-- hash is portable, and this file never signs in as her anyway -- both feeds are read
-- by the merchant and by the platform owner.
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${MEMBER}', '${SALON_B}', '${MEMBER_NAME}', '${MEMBER_PHONE}', NULL, false,
       s.password_hash, 0, 0, 'bronze', NULL, 1
FROM staff_user s WHERE s.id = '${B_STAFF}'
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- The reversals point at charges in the same batch, so the charges must exist first.
-- One statement with the charges ordered ahead of the adjustments would rely on
-- Postgres evaluating a multi-row INSERT row by row against its own FK, which it does
-- not; so the reversal rows are inserted second, by kind.
INSERT INTO transaction
  (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, bonus_fils,
   promo_bonus_fils, method, status, reference, note, reverses_transaction_id,
   created_by_staff_id, created_at, settled_at)
VALUES ${txValues.filter((_, i) => ALL_TX[i]?.reverses === undefined).join(',\n       ')}
ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction
  (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, bonus_fils,
   promo_bonus_fils, method, status, reference, note, reverses_transaction_id,
   created_by_staff_id, created_at, settled_at)
VALUES ${txValues.filter((_, i) => ALL_TX[i]?.reverses !== undefined).join(',\n       ')}
ON CONFLICT (id) DO NOTHING;

INSERT INTO loyalty_event
  (id, salon_id, member_id, kind, from_tier, to_tier, stamps_after, stamp_target, created_at)
VALUES ${loyaltyValues.join(',\n       ')}
ON CONFLICT (id) DO NOTHING;

COMMIT;
  `);
}

function clearFeed(): void {
  psql(`
    DELETE FROM loyalty_event WHERE salon_id = '${SALON_B}' AND member_id = '${MEMBER}';
    DELETE FROM transaction   WHERE salon_id = '${SALON_B}' AND member_id = '${MEMBER}'
                                AND reverses_transaction_id IS NOT NULL;
    DELETE FROM transaction   WHERE salon_id = '${SALON_B}' AND member_id = '${MEMBER}';
    DELETE FROM member        WHERE salon_id = '${SALON_B}' AND id = '${MEMBER}';
  `);
}

// ------------------------------------------------------------ the two surfaces --

interface FeedItem {
  id: string;
  stream: string;
  who: string;
  memberId: string | null;
  salonId: string | null;
  what: string;
  kind: string;
  amountFils: number | null;
}

/**
 * Both feeds, indexed by row id.
 *
 * `limit=100` is `FEED_MAX_LIMIT`, and the fixture rows are the NEWEST in the salon by
 * construction — `created_at` is `now()` minus milliseconds, and every other row at
 * salon B was written by an earlier file of the same run. So a fixture row missing
 * from either map is a real absence, not a paging artefact, and the lookup helper
 * says so by name.
 */
let merchantFeed = new Map<string, FeedItem>();
let platformFeed = new Map<string, FeedItem>();

async function loadFeeds(): Promise<void> {
  const m = await treq<{ items: FeedItem[] }>('GET', `/salons/${SALON_B}/activity?limit=100`, {
    token: dashboard,
  });
  precondition(m.status === 200, `GET /salons/${SALON_B}/activity: ${m.status} ${m.raw}`);
  merchantFeed = new Map(m.body.items.map((i) => [i.id, i]));

  const p = await treq<{ items: FeedItem[] }>(
    'GET',
    `/v1/platform/activity?limit=100&salon=${SALON_B}`,
    { token: platform },
  );
  precondition(p.status === 200, `GET /v1/platform/activity: ${p.status} ${p.raw}`);
  platformFeed = new Map(p.body.items.map((i) => [i.id, i]));
}

/** The merchant's line for a row, or a failure naming which surface lost it. */
function merchantLine(id: string): FeedItem {
  const row = merchantFeed.get(id);
  if (!row) {
    throw new Error(
      `${id} is not in the merchant activity feed. The row is a fixture inserted by ` +
        'seedFeed() and is the newest at this salon, so this is not a paging artefact: ' +
        'either the insert failed, or the feed is filtering it out. GET ' +
        `/salons/${SALON_B}/activity?limit=100 returned ${merchantFeed.size} rows.`,
    );
  }
  return row;
}

function platformLine(id: string): FeedItem {
  const row = platformFeed.get(id);
  if (!row) {
    throw new Error(
      `${id} is not in the PLATFORM activity feed, though the merchant's own feed has it. ` +
        'The two reads share `FEED_KINDS` and both filter on it, so a row on one and not ' +
        `the other is a divergence between the surfaces. GET /v1/platform/activity returned ` +
        `${platformFeed.size} rows for salon ${SALON_B}.`,
    );
  }
  return row;
}

/**
 * THE PROPERTY THE SERVICE EXISTS TO HOLD, asserted for every row this file touches.
 *
 * `services/activityFeed.ts` was extracted so the merchant's read and the console's
 * read could not phrase the same record differently — "a `kind` chip that means
 * something slightly different on the console than on the dashboard… turns 'these two
 * screens disagree' into a question about the record itself." Both handlers still
 * compose the item themselves, so the sharing is a convention and not a structure,
 * and this is what makes it a fact.
 */
function bothSurfacesAgree(id: string): FeedItem {
  const mine = merchantLine(id);
  const theirs = platformLine(id);
  expect(
    theirs.what,
    `the two feeds phrase ${id} differently.\n  merchant: ${mine.what}\n  platform: ` +
      `${theirs.what}\nservices/activityFeed.ts exists to make that impossible; both ` +
      'handlers compose the item themselves, so nothing but this spec holds them together.',
  ).toBe(mine.what);
  expect(theirs.kind, `the two feeds disagree about the kind chip on ${id}`).toBe(mine.kind);
  expect(theirs.amountFils, `the two feeds disagree about the amount on ${id}`).toBe(
    mine.amountFils,
  );
  return mine;
}

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  platform = await signInPlatform(PLATFORM_OWNER_HANDLE);
  clearFeed();
  seedFeed();
  await loadFeeds();
}, 180_000);

afterAll(async () => {
  /**
   * EVERY ROW THIS FILE WROTE, REMOVED — reversals before charges, because
   * `reverses_transaction_id` is `ON DELETE restrict`.
   *
   * Not optional housekeeping. `reports.test.ts` reads salon B's sales figures later
   * in the same run and thirty settled transactions would move them; the lesson
   * `configuration.test.ts`'s teardown records is that a fixture left behind stops
   * being scaffolding and becomes another file's premise.
   */
  clearFeed();
  await stopTenancyApi();
});

// ===========================================================================
// THE DERIVATION ITSELF
// ===========================================================================

describe('the derivation — four constants read from source, each checked against the deployment', () => {
  it('`FEED_KINDS` was read out of the service, and holds the known positives', () => {
    /**
     * THE PARSER IS LOAD-BEARING, proved against known positives before anything is
     * concluded from it. A regex that matched the declaration but read no literals out
     * of it would make every loop below iterate zero times and report this file green
     * with the switch untested — which is the exact state the file was written to end.
     *
     * The count is not pinned; `campaigns.test.ts` § "the derivation itself" settles
     * that reasoning and it holds here: a pinned count turns red the day somebody
     * deliberately adds a kind, and this file's purpose is that the new kind is
     * COVERED rather than that it does not exist. `constArrayFromSource` throws on an
     * emptied constant, which is what a pinned count would have guarded.
     */
    expect(
      FEED_KINDS.length,
      `only ${FEED_KINDS.length} kind(s) were read out of ${FEED_SERVICE_FILE}`,
    ).toBeGreaterThanOrEqual(2);
    for (const known of ['topup', 'charge', 'adjustment'] as const) {
      expect(
        FEED_KINDS,
        `"${known}" is not among the feed kinds read from source (${FEED_KINDS.join(', ')}). ` +
          'If the reader is wrong, every derived spec below is testing the wrong set.',
      ).toContain(known);
    }
  });

  it('`AMOUNT_FOR_KIND` covers exactly `FEED_KINDS` — no kind is silently skipped', () => {
    /**
     * THE ONE PLACE A LIST IS TYPED IN THIS FILE, AND THE SPEC THAT KEEPS IT HONEST.
     *
     * The signed amount per kind cannot be derived — see the map's own comment — so a
     * new feed kind needs a line there. `amountForKind()` already throws at collection
     * time if one is missing, which is what actually stops a run; this spec states the
     * same requirement as a CLAIM, in the section a reader opens to find out what this
     * file is derived from. A reader who sees the throw goes looking for the rule, and
     * the rule should be somewhere other than inside the thing that enforces it.
     */
    expect(
      Object.keys(AMOUNT_FOR_KIND).sort(),
      'AMOUNT_FOR_KIND and FEED_KINDS have diverged. Add the new kind with an amount whose ' +
        'SIGN `transaction_amount_sign_matches_kind` permits, and give it a sentence in ' +
        '§ THE SENTENCES, THEMSELVES.',
    ).toEqual([...FEED_KINDS].sort());
  });

  it('every feed kind is a real `transaction_kind`, and `deposit_hold` is still excluded', () => {
    /**
     * THE CROSS-CHECK AGAINST THE DEPLOYED ARTIFACT. `FEED_KINDS` is a TypeScript
     * array and the feed's query is `inArray(transaction.kind, [...FEED_KINDS])` — so a
     * kind in the array that is not a `transaction_kind` label is an invalid-input-value
     * error on a SELECT, which is a 500 on the merchant's Overview.
     *
     * AND THE EXCLUSION IS ASSERTED AS AN EXCLUSION. `deposit_hold` is left out
     * deliberately and the service argues for it at length — the merchant already sees
     * the booking in Appointments, so the feed would report one event twice. Pinning it
     * means adding `deposit_hold` to `FEED_KINDS` fails HERE, pointing at that
     * argument, rather than quietly doubling every booking on two surfaces.
     */
    const labels = pgEnumLabels('transaction_kind');
    expect(
      labels,
      'the `transaction_kind` Postgres enum is not on this database, so this spec is ' +
        'reading nothing and proving nothing',
    ).not.toEqual([]);

    for (const kind of FEED_KINDS) {
      expect(
        labels,
        `FEED_KINDS contains "${kind}", which is not a \`transaction_kind\` label ` +
          `(${labels.join(', ')}). The feed's own \`inArray\` filter would answer 500.`,
      ).toContain(kind);
    }

    expect(
      FEED_KINDS,
      'FEED_KINDS now includes `deposit_hold`. The service excludes it on purpose — the ' +
        'merchant already sees the booking in Appointments, and the feed would report the ' +
        'same event twice, once as an appointment and once as a debit that is not a sale. ' +
        'Its counterpart `deposit_return` IS included. If the decision has genuinely ' +
        'changed, change this spec and the paragraph in services/activityFeed.ts together.',
    ).not.toContain('deposit_hold');
  });

  it('`loyaltyEventKind` matches the deployed `loyalty_event_kind` type exactly', () => {
    const labels = pgEnumLabels(LOYALTY_ENUM.typeName);
    expect(
      labels,
      `the Postgres enum \`${LOYALTY_ENUM.typeName}\` is not on this database`,
    ).not.toEqual([]);
    expect(
      [...labels].sort(),
      'the values the DATABASE admits and the values the SCHEMA declares disagree.\n' +
        `  pg_enum:          ${labels.join(', ')}\n` +
        `  loyaltyEventKind: ${LOYALTY_KINDS.join(', ')}`,
    ).toEqual([...LOYALTY_KINDS].sort());

    for (const known of ['tier_climb', 'stamp_reward_ready'] as const) {
      expect(
        LOYALTY_KINDS,
        `"${known}" is not among the loyalty kinds read from source. Before this file, ` +
          'NEITHER of them appeared in any test file in this repository.',
      ).toContain(known);
    }
  });

  it('and the CHECK that decides which loyalty kinds are WRITABLE names the same set', () => {
    /**
     * TWO GATES, AND THE SECOND ONE IS THE STRICTER. `loyalty_event_kind_matches_fields`
     * is `(kind = 'tier_climb' AND stamps_after IS NULL) OR (kind = 'stamp_reward_ready'
     * AND to_tier IS NULL)` — an enumeration, not a rule. A third kind added to the
     * enum and to the type is therefore UNWRITABLE: every INSERT violates that CHECK,
     * whatever columns it sets. So the feature would ship with an enum value nothing
     * can produce, and `describeLoyalty` — which has no default arm — would render it
     * as "filled the stamp card · 0 of 0" if anything ever did.
     *
     * The literals in the CHECK are compared to the enum rather than the syntax being
     * matched, exactly as `campaigns.test.ts` compares `pg_get_constraintdef()` for
     * `campaign_audience_is_known`: Postgres normalises the expression and the literals
     * are the part that means something in either rendering.
     */
    const def = constraintDef('loyalty_event_kind_matches_fields');
    expect(
      def,
      'the CHECK `loyalty_event_kind_matches_fields` is not on this database. Either the ' +
        'migration that adds it was dropped or it was renamed, in which case this spec is ' +
        'reading nothing.',
    ).not.toBe('');

    const named = quotedStrings(def);
    for (const kind of LOYALTY_KINDS) {
      expect(
        named,
        `the loyalty kind "${kind}" is in the enum and is NOT named by ` +
          `\`loyalty_event_kind_matches_fields\` (${def}). Every INSERT of that kind violates ` +
          'the CHECK, so the value exists and nothing can write it — and `describeLoyalty` ' +
          'has no default arm, so if something ever did it would read as a filled stamp card.',
      ).toContain(kind);
    }
  });

  it('`METHOD_LABEL` has a label for every `payment_method`, so no raw value reaches a merchant', () => {
    /**
     * `describeTransaction` writes `METHOD_LABEL[row.method] ?? row.method`. The
     * fallback is correct defensive code and it is also the leak: a payment method
     * added to the enum and not to the map puts the DATABASE's spelling on the
     * merchant's Overview — "topped up 25.000 via applepay" rather than "via Apple
     * Pay". Nothing else in the repository compares the two.
     */
    const labels = pgEnumLabels('payment_method');
    expect(labels, 'the `payment_method` Postgres enum is not on this database').not.toEqual([]);

    for (const method of labels) {
      expect(
        Object.keys(METHOD_LABEL),
        `\`payment_method\` includes "${method}" and METHOD_LABEL has no entry for it, so ` +
          `\`METHOD_LABEL[row.method] ?? row.method\` will print "${method}" verbatim to a ` +
          'merchant. Add a label in services/activityFeed.ts.',
      ).toContain(method);
    }
  });

  it('`TIER_LABEL` and `describeLoyalty`\'s own ladder both cover every `tier_name`', () => {
    /**
     * TWO SEPARATE HAZARDS ON ONE ENUM, and the second is the sharper one.
     *
     * TIER_LABEL is the same `?? row.toTier` leak as METHOD_LABEL — a tier without a
     * label reads "reached black tier" in lower case.
     *
     * `describeLoyalty`'s local `const order = ['bronze', 'silver', 'gold', 'black']`
     * is worse than cosmetic. The descent test is
     * `order.indexOf(row.toTier) < order.indexOf(row.fromTier)`, and `indexOf` returns
     * -1 for anything absent. A tier missing from that array is therefore treated as
     * BELOW every other tier: a promotion INTO it reads as a descent ("moved to X tier
     * from Gold"), and a promotion out of it makes every real climb read as one too.
     * The row carries both ends precisely so the feed can avoid "announcing 'reached
     * Bronze' to someone who was demoted", and a stale ladder inverts exactly that.
     */
    const tiers = pgEnumLabels('tier_name');
    expect(tiers, 'the `tier_name` Postgres enum is not on this database').not.toEqual([]);

    for (const tier of tiers) {
      expect(
        Object.keys(TIER_LABEL),
        `\`tier_name\` includes "${tier}" and TIER_LABEL has no entry for it, so the feed ` +
          `will print "${tier}" verbatim`,
      ).toContain(tier);
    }

    expect(
      TIER_ORDER,
      "`describeLoyalty`'s local `order` ladder and the `tier_name` enum have diverged.\n" +
        `  order:     ${TIER_ORDER.join(', ')}\n  tier_name: ${tiers.join(', ')}\n` +
        'A tier absent from `order` gets `indexOf` -1, which reads as below every other ' +
        'tier — so a promotion into it is reported to the customer as a demotion. The order ' +
        'itself matters, not just the membership, because the comparison is positional.',
    ).toEqual(tiers);
  });
});

// ===========================================================================
// EVERY FEED KIND — DERIVED
// ===========================================================================

describe('every kind in FEED_KINDS gets a sentence of its own, on both surfaces', () => {
  /**
   * WHAT A DERIVED LOOP CAN HONESTLY SAY ABOUT A PER-CASE SWITCH.
   *
   * Not the sentence — each case composes different prose, which is the whole point of
   * the switch. What the loop asserts is the failure mode: `describeTransaction` ends
   * `default: return \`${row.kind} ${amount}\``, so a kind added to `FEED_KINDS` with
   * no case of its own renders the raw enum value and a bare number. "deposit_hold
   * 5.000", on a merchant's Overview panel, in the place a sentence goes.
   *
   * That is the same shape as the bug this technique exists for — a list widened and a
   * per-value branch not — so it is the thing worth a derived spec.
   */
  for (const kind of FEED_KINDS) {
    it(`a settled "${kind}" row is described, not defaulted, and both feeds agree`, () => {
      const id = tx(`KIND-${kind.toUpperCase()}`);
      const row = bothSurfacesAgree(id);

      expect(row.kind, `the ${kind} row came back under kind "${row.kind}"`).toBe(kind);
      expect(row.stream).toBe('transaction');
      expect(row.memberId).toBe(MEMBER);
      expect(row.salonId, 'a merchant feed row with no salon on it').toBe(SALON_B);

      const amount = amountForKind(kind);
      expect(
        row.amountFils,
        `the wire's amount for the ${kind} row is not the signed value stored. The feed ` +
          'serves it "signed as stored, so a client never has to infer direction from the ' +
          'kind".',
      ).toBe(amount);

      expect(row.what.trim(), `the ${kind} row has an empty sentence`).not.toBe('');
      expect(
        row.what,
        `the "${kind}" row fell through to \`describeTransaction\`'s default arm and reads ` +
          `"${row.what}" — a raw enum value and a bare number where a sentence goes. Either ` +
          'the kind was added to FEED_KINDS without a case in the switch, or its case was ' +
          'removed.',
      ).not.toBe(`${kind} ${kd(amount)}`);

      /**
       * AND IT SAYS THE AMOUNT. Every case in the switch interpolates `kd(...)` — the
       * `topup` case with the bonus subtracted, which is why the expected figure here is
       * the row's own and not the raw column. A sentence that named no number would pass
       * the default-arm check above and still be useless to a merchant.
       */
      expect(
        row.what,
        `the "${kind}" sentence ("${row.what}") does not contain the amount ${kd(amount)}`,
      ).toContain(kd(amount));
    });
  }

  it('and the named specs below cover every feed kind — no case is left unphrased', () => {
    /**
     * THE COMPLETENESS GUARD FOR THE EXACT-STRING SECTION. § THE SENTENCES, THEMSELVES
     * pins one literal per branch, and a literal cannot be derived. So the KINDS those
     * specs speak for are listed once, here, and required to be all of them: a sixth
     * feed kind fails at this line asking for its sentence, instead of being covered
     * only by the shape assertions above.
     */
    const phrased = ['topup', 'charge', 'deposit_return', 'shop', 'adjustment'];
    expect(
      [...phrased].sort(),
      'FEED_KINDS has a kind that § THE SENTENCES, THEMSELVES does not pin an exact string ' +
        'for. The shape loop above only proves the sentence is not the default arm; the ' +
        "prose a merchant actually reads is only guarded where it is written down.",
    ).toEqual([...FEED_KINDS].sort());
  });
});

// ===========================================================================
// EVERY LOYALTY KIND — DERIVED
// ===========================================================================

describe('every kind in loyaltyEventKind gets its own sentence', () => {
  /**
   * `describeLoyalty` HAS NO DEFAULT ARM. It is `if (row.kind === 'tier_climb') { … }`
   * followed by an unconditional stamp-card return — so a third kind does not fall
   * through to something visibly wrong, it falls through to something plausibly wrong:
   * "filled the stamp card · 0 of 0", a sentence about a feature the salon may not even
   * run.
   *
   * A loop cannot know a new kind's sentence, but it can require the sentences to be
   * MUTUALLY DISTINCT, which is what catches a kind silently borrowing another's.
   */
  const kindRow = (kind: string): number =>
    kind === 'tier_climb' ? 1 : (LOYALTY_ROWS.find((r) => r.kind === kind)?.n ?? -1);

  for (const kind of LOYALTY_KINDS) {
    it(`a "${kind}" row is described, and both feeds agree`, () => {
      const n = kindRow(kind);
      precondition(
        n > 0,
        `no fixture row exists for loyalty kind "${kind}". LOYALTY_ROWS is built from ` +
          'TIER_ORDER plus two named stamp rows; a new kind needs a row whose columns ' +
          '`loyalty_event_kind_matches_fields` permits.',
      );

      const row = bothSurfacesAgree(le(n));
      expect(row.stream).toBe('loyalty');
      expect(row.kind).toBe(kind);
      expect(
        row.amountFils,
        'a loyalty line reported an amount. It moved no money — `amountFils` is null on a ' +
          'line that moved none, and a client rendering a figure here would invent one.',
      ).toBeNull();
      expect(row.who, "the loyalty line does not name the member it is about").toBe(MEMBER_NAME);
      expect(row.what.trim(), `the ${kind} row has an empty sentence`).not.toBe('');
    });
  }

  it('the loyalty kinds do not share a sentence — a new kind cannot borrow the stamp line', () => {
    const sentences = new Map<string, string>();
    for (const kind of LOYALTY_KINDS) {
      const n = kindRow(kind);
      if (n > 0) sentences.set(kind, merchantLine(le(n)).what);
    }
    const unique = new Set(sentences.values());
    expect(
      unique.size,
      'two loyalty kinds produced the same sentence:\n' +
        [...sentences].map(([k, v]) => `  ${k}: ${v}`).join('\n') +
        '\n`describeLoyalty` has no default arm, so a kind with no branch of its own falls ' +
        'through to the stamp-card line. That is what this looks like.',
    ).toBe(sentences.size);
  });
});

// ===========================================================================
// THE SENTENCES, THEMSELVES
// ===========================================================================

describe('describeTransaction — topup, where the arithmetic is', () => {
  it('a bonused top-up reports what the customer PAID, not what landed', () => {
    /**
     * THE DEFECT THE SERVICE HEADER SAYS WAS ALREADY FOUND AND FIXED ONCE, and this is
     * the first assertion anywhere that would catch it coming back.
     *
     * `amount_fils` is "what actually landed, bonus included" (`services/topup.ts`), so
     * a 25.000 KNET top-up at a tier paying 20% stores 30000 with 5000 in `bonus_fils`.
     * Printing the column reads "topped up 30.000 · +5.000 bonus", which counts the
     * bonus twice and tells a merchant her customer paid five dinars she did not.
     * `- row.bonusFils` is the whole fix, and it was unguarded.
     *
     * BOTH NUMBERS ARE ASSERTED, which is what makes this a guard rather than a
     * restatement: the SENTENCE says 25.000 and the wire's `amountFils` says 30000. A
     * "fix" that changed the column instead of the prose would satisfy one and fail the
     * other, and the column is what the ledger and the settlement report count.
     */
    const row = bothSurfacesAgree(tx('TOPUP-BONUS'));
    expect(
      row.what,
      'the bonused top-up sentence has drifted. If it now reads "topped up 30.000", the ' +
        'bonus is being counted twice — the defect services/activityFeed.ts records as ' +
        'already found and fixed once, with nothing guarding it until now.',
    ).toBe('topped up 25.000 via KNET · +5.000 bonus');
    expect(
      row.amountFils,
      'the sentence was corrected by changing the COLUMN, which is not the same fix: ' +
        '`amount_fils` is what landed in the wallet and the ledger counts it.',
    ).toBe(30_000);
  });

  it('an unbonused top-up says nothing about a bonus', () => {
    /**
     * The other side of `row.bonusFils > 0 ? … : ''`. A "· +0.000 bonus" suffix on every
     * stamps-mode or bronze-tier top-up would be noise on the panel the design draws as
     * five clean lines — and `bonus_fils` is "Always 0 in stamps mode", so this is the
     * COMMON case, not the corner one.
     *
     * `card` also proves the label lookup does not upper-case or prettify: METHOD_LABEL
     * maps `card` to the lower-case word, and "via Card" would be wrong copy.
     */
    const row = bothSurfacesAgree(tx('TOPUP-PLAIN'));
    expect(row.what).toBe('topped up 25.000 via card');
    expect(row.what, 'a zero bonus was announced').not.toContain('bonus');
  });

  it('a top-up with no method recorded omits the "via" clause rather than saying "via null"', () => {
    /**
     * `const via = row.method ? \` via …\` : ''`. `method` is a NULLABLE column with no
     * CHECK tying it to `kind`, so a top-up written by any path that does not know the
     * method — a manual credit, a migration, a future admin tool — reaches here with
     * null. Without the guard the sentence reads "topped up 20.000 via null", and the
     * guard had no test.
     */
    const row = bothSurfacesAgree(tx('TOPUP-NOMETHOD'));
    expect(row.what).toBe('topped up 20.000');
    expect(row.what.toLowerCase(), 'a null method reached the merchant as prose').not.toContain(
      'null',
    );
  });

  /**
   * EVERY PAYMENT METHOD NAMES ITS LABEL, derived from `payment_method` by way of
   * `METHOD_LABEL`.
   *
   * The map is cross-checked against the enum in § the derivation, so this loop covers
   * every method the database admits. What it adds is that the label actually REACHES
   * the sentence — a lookup that silently returned the key would pass the map check and
   * still print "via applepay".
   */
  for (const [method, label] of Object.entries(METHOD_LABEL)) {
    it(`a top-up by "${method}" is described as "via ${label}"`, () => {
      const row = bothSurfacesAgree(tx(`METHOD-${method.toUpperCase()}`));
      expect(
        row.what,
        `a "${method}" top-up reads "${row.what}". METHOD_LABEL maps it to "${label}", and ` +
          'the fallback `?? row.method` is what puts the database\'s own spelling in front ' +
          'of a merchant.',
      ).toBe(`topped up 10.000 via ${label}`);
    });
  }
});

// ---------------------------------------------------------------------------
// § THE SECOND BONUS COLUMN
// ---------------------------------------------------------------------------

describe('the second bonus column — the same defect, one column over', () => {
  /**
   * FOUND BY WRITING THE GUARD FOR THE FIRST ONE, and reported rather than fixed
   * because `api/` is lane A's column.
   *
   * `services/topup.ts` settles a top-up as:
   *
   *     const credit = add(add(input.amountFils, bonus), promoBonus);
   *     …
   *     amountFils: intent.creditFils,      // the transaction row's amount_fils
   *     bonusFils: intent.bonusFils,
   *     promoBonusFils: intent.promoBonusFils,
   *
   * so `amount_fils` on the row is paid + tier bonus + PROMOTION bonus.
   * `describeTransaction` computes `paid = row.amountFils - row.bonusFils`, subtracting
   * only the tier bonus — so a happy-hour top-up reports a figure the customer never
   * paid, inflated by exactly the promo bonus, AND does not mention the promo bonus at
   * all because the suffix is gated on `bonusFils > 0`.
   *
   * WHY THE TWO COLUMNS EXIST AT ALL is the schema's own argument, and it makes this a
   * defect rather than a modelling question: "nothing stored would say how much of one
   * number the merchant funded because of a customer's standing and how much because of
   * a promotion she was running. Two different budget lines, one column, no way back."
   * The feed is the surface where the merchant reads those lines, and it currently adds
   * one of them to the customer's payment.
   *
   * A 25.000 KNET top-up during a `topup20`-style happy hour paying 2.000 stores
   * `amount_fils = 27000`, `bonus_fils = 0`, `promo_bonus_fils = 2000`. The sentence a
   * merchant should read is "topped up 25.000 via KNET · +2.000 bonus".
   *
   * WRITTEN AS `knownBug()` FOR THE REASON THAT HELPER EXISTS: the assertion below is
   * the contract, it fails today, and the hour lane A subtracts `promoBonusFils` too it
   * goes RED asking to be promoted to a plain `it()`. A prose bug report would rot; an
   * assertion of the broken behaviour would cement it.
   */
  knownBug(
    'a happy-hour top-up reports the promo bonus as money the customer paid',
    async () => {
      const row = merchantLine(tx('TOPUP-PROMO'));
      precondition(
        row.amountFils === 27_000,
        `the promo fixture row is not the one this bug is about: amountFils=${row.amountFils}`,
      );
      precondition(
        Number(scalar(`select promo_bonus_fils from transaction where id='${tx('TOPUP-PROMO')}'`)) ===
          2_000,
        'the promo fixture row has no promo_bonus_fils, so this spec cannot see the defect',
      );

      expect(row.what).toBe('topped up 25.000 via KNET · +2.000 bonus');
    },
  );

  it('and the row IS reaching the feed, so the knownBug above is about the sentence', () => {
    /**
     * THE HALF THAT MUST NOT BE A knownBug. If the promo row were simply absent from the
     * feed, the assertion above would fail for the wrong reason and read as the same
     * defect. `precondition()` inside a `knownBug()` throws a plain Error rather than an
     * assertion failure and so is re-thrown — that is the guard — and this spec states
     * the same thing positively, where a reader will see it.
     */
    const row = bothSurfacesAgree(tx('TOPUP-PROMO'));
    expect(row.kind).toBe('topup');
    expect(row.what, 'the promo top-up has no sentence at all').not.toBe('');
    expect(
      row.what.startsWith('topped up '),
      `the promo top-up reads "${row.what}", which is not the topup case's prose at all`,
    ).toBe(true);
  });
});

describe('describeTransaction — the other four cases', () => {
  it('a charge says what was paid, unsigned', () => {
    /**
     * `case 'charge': return \`paid ${amount}\`` where `amount` is `kd(row.amountFils)`
     * and `kd` is absolute. The row is stored NEGATIVE — the sign CHECK requires it —
     * so the absolute value is what makes "paid 12.000" rather than "paid -12.000", and
     * the signed figure still reaches the client separately in `amountFils`.
     *
     * THE DESIGN'S OWN LINE IS "paid 12.000 · Cut & style" and this sentence carries no
     * basket. That is not a defect to assert against: the service composes from the
     * `transaction` row, and what the charge was for lives in `basket_hash` as a digest
     * — there is nothing to print. Recorded here because the gap between the design
     * comment at the top of `routes/activity.ts` and the string is otherwise the kind of
     * thing a later reader "fixes" by inventing a lookup.
     */
    const row = bothSurfacesAgree(tx('CHARGE'));
    expect(row.what).toBe('paid 12.000');
    expect(row.amountFils, 'the charge reached the wire unsigned').toBe(-12_000);
  });

  it('a ZERO charge is still described as a charge — migration 0014\'s legitimate row', () => {
    /**
     * `charge` is `<= 0` where the other debit kinds are `< 0`, and the schema explains
     * why: a charge records what was debited AFTER a held deposit was applied, so "a
     * 6.000 manicure against a 10.000 deposit… debits nothing further and the row is
     * legitimately zero. That is still a real visit."
     *
     * It is also the row most likely to be mistaken for missing data by anything that
     * tests truthiness, so the feed saying "paid 0.000" rather than an empty sentence is
     * worth pinning.
     */
    const row = bothSurfacesAgree(tx('CHARGE-ZERO'));
    expect(row.what).toBe('paid 0.000');
    expect(row.amountFils).toBe(0);
  });

  it('a staff-returned deposit names its reason', () => {
    const row = bothSurfacesAgree(tx('DEPRET-NOTE'));
    expect(row.what).toBe('deposit returned 5.000 · Aisha M. no-show');
    expect(row.who, 'the line is attributed to somebody other than the customer').toBe(MEMBER_NAME);
  });

  it('and one with no reason recorded does not trail a separator', () => {
    // `${row.note ? ` · ${row.note}` : ''}` — the guard, whose absence would leave
    // "deposit returned 5.000 · " with a dangling middot on the panel.
    const row = bothSurfacesAgree(tx('DEPRET-NONOTE'));
    expect(row.what).toBe('deposit returned 5.000');
    expect(row.what.endsWith('·'), 'a dangling separator').toBe(false);
  });

  it('an AUTOMATIC deposit return is attributed to System, and the ROUTE phrases it', () => {
    /**
     * THE ONE LINE NEITHER SERVICE FUNCTION COMPOSES. Both handlers special-case
     * `kind === 'deposit_return' && createdByStaffId === null` and build the sentence
     * inline — "returned 5.000 deposit · <member>" — with `who` set to "System", the
     * actor `writeAudit` records for a principal-less write. It is the design's own
     * third feed line.
     *
     * ASSERTED HERE BECAUSE IT IS DUPLICATED IN TWO ROUTE FILES. `describeTransaction`
     * was extracted so the two feeds could not phrase a record differently, and this
     * particular sentence sits OUTSIDE that extraction, copied into both handlers. It is
     * therefore the one line where the surfaces can drift without touching the service
     * — which is exactly what `bothSurfacesAgree` is for.
     */
    const row = bothSurfacesAgree(tx('DEPRET-SYSTEM'));
    expect(row.who, 'an unattended deposit return was attributed to the customer').toBe('System');
    expect(row.what).toBe(`returned 4.000 deposit · ${MEMBER_NAME}`);
    expect(
      row.what,
      "the System line fell through to describeTransaction's deposit_return case, which " +
        'names the note instead of the member',
    ).not.toContain('deposit returned');
  });

  it('a shop line names the shop and the amount', () => {
    const row = bothSurfacesAgree(tx('SHOP'));
    expect(row.what).toBe('bought from the shop · 9.500');
    expect(row.amountFils).toBe(-9_500);
  });
});

describe('describeTransaction — adjustment, which is two sentences behind one kind', () => {
  it('a void is named as the reversal it is, with its reason', () => {
    /**
     * `row.reversesTransactionId ? … : …`. A void arrives as a compensating `adjustment`
     * pointing back at the charge it reverses, and the service says why the branch
     * exists: "'adjusted 12.000' in a feed is the one line a merchant will stop and ask
     * about."
     *
     * `12.000 returned` and not `-12.000`: the compensating row is stored POSITIVE
     * because it credits the wallet, and `kd` is absolute either way.
     */
    const row = bothSurfacesAgree(tx('VOID-NOTE'));
    expect(row.what).toBe('charge voided · 12.000 returned · wrong service rung up');
    expect(
      row.kind,
      'the void reached the wire under a kind of its own. It is an `adjustment`, and a ' +
        'client colours the row by this field.',
    ).toBe('adjustment');
  });

  it('a void with no reason recorded still says it was a void', () => {
    const row = bothSurfacesAgree(tx('VOID-NONOTE'));
    expect(row.what).toBe('charge voided · 8.000 returned');
  });

  it('a CREDIT adjustment is signed with a plus', () => {
    const row = bothSurfacesAgree(tx('ADJ-POS'));
    expect(row.what).toBe('wallet adjusted +3.000 · goodwill credit');
  });

  it('a DEBIT adjustment is signed with a MINUS SIGN, not a hyphen', () => {
    /**
     * `${row.amountFils > 0 ? '+' : '−'}` — U+2212 MINUS SIGN, not U+002D HYPHEN-MINUS.
     *
     * A spec that pinned the sentence with a hyphen would pass review, read identically
     * in most fonts, and lock in the wrong character. Asserted by CODE POINT as well as
     * by string, because that is the only form of this assertion a reader cannot
     * misread — and because the design's typography is settled copy, not a detail
     * (CLAUDE.md § Keep the copy verbatim).
     *
     * It also matters for Arabic. Non-negotiable #12 puts money in Western digits inside
     * an RTL layout; a hyphen-minus is a bidi-neutral character that resolves against
     * the surrounding paragraph direction, and U+2212 does not. The wrong character can
     * therefore render on the wrong END of the number in Arabic.
     */
    const row = bothSurfacesAgree(tx('ADJ-NEG'));
    expect(row.what).toBe('wallet adjusted −3.000');
    expect(
      row.what.includes('−'),
      `the debit adjustment reads "${row.what}" without U+2212 MINUS SIGN. If it now uses ` +
        'U+002D HYPHEN-MINUS the two are visually near-identical here and misplace the sign ' +
        'in RTL, where a bidi-neutral hyphen resolves against the paragraph direction.',
    ).toBe(true);
    expect(
      row.what.includes('-'),
      'the debit adjustment uses an ASCII hyphen where the service writes U+2212',
    ).toBe(false);
  });
});

describe('describeLoyalty — the climb, the descent, and the stamp card', () => {
  /**
   * EVERY TIER AS A DESTINATION, derived from the ladder, climbing from the rung below.
   *
   * What it proves per tier is that the LABEL reaches the sentence — "reached Gold
   * tier", not "reached gold tier" — and that a climb from the rung below is reported as
   * a climb rather than as a descent, which is what a ladder out of step with the enum
   * would break. The lowest rung has no rung below, so it also covers the
   * `fromTier === null` branch: "a member who was on no tier yet".
   */
  for (const tier of TIER_ORDER) {
    it(`a climb to "${tier}" reads as reaching ${TIER_LABEL[tier] ?? tier} tier`, () => {
      const row = bothSurfacesAgree(le(climbFor(tier).n));
      expect(
        row.what,
        `a climb to "${tier}" reads "${row.what}". Expected the TIER_LABEL spelling and the ` +
          'climb phrasing — a descent phrasing here means `order.indexOf` is placing this ' +
          "tier below the one beneath it, which is `describeLoyalty`'s ladder out of step " +
          'with `tier_name`.',
      ).toBe(`reached ${TIER_LABEL[tier] ?? tier} tier`);
    });
  }

  it('a DESCENT says so, and names where she came from', () => {
    /**
     * THE BRANCH THE ROW CARRIES BOTH ENDS FOR. `describeLoyalty`'s own comment: "A
     * republished ladder can move a member DOWN — see services/charge.ts. The row
     * carries both ends so the feed can say which happened rather than announcing
     * 'reached Bronze' to someone who was demoted."
     *
     * Nothing had ever driven it. A merchant who republishes her tier thresholds moves
     * real customers down, and the feed congratulating them is the version of this bug
     * that reaches a customer through a merchant reading it aloud.
     */
    const row = bothSurfacesAgree(le(1));
    expect(
      row.what,
      'a member moved from Gold to Bronze was congratulated on reaching Bronze',
    ).toBe('moved to Bronze tier from Gold');
  });

  it('a filled stamp card reports where the card stood', () => {
    const row = bothSurfacesAgree(le(2));
    expect(row.what).toBe('filled the stamp card · 6 of 6');
  });

  it('and a stamp row with nothing recorded reads as zero of zero, not as NaN or null', () => {
    /**
     * `${row.stampsAfter ?? 0} of ${row.stampTarget ?? 0}`. Both columns are nullable and
     * `loyalty_event_stamp_has_card` requires them on a `stamp_reward_ready` row — so
     * the `?? 0` is unreachable through that CHECK today, and this row exercises the
     * ARITHMETIC path with zeroes instead: the numbers are interpolated raw, with no
     * `kd()`, because they are counts and not money. A stamp count that ever went
     * through the money formatter would read "filled the stamp card · 0.006 of 0.006".
     */
    const row = bothSurfacesAgree(le(3));
    expect(row.what).toBe('filled the stamp card · 0 of 0');
    expect(row.what, 'a stamp count went through the money formatter').not.toContain('.');
  });
});
