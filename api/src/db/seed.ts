/**
 * Development seed. `pnpm --dir=/abs/path/to/api run db:seed`
 *
 * AN ABSOLUTE `--dir`, NEVER `--filter`, AND NEVER A RELATIVE PATH. `pnpm --filter`
 * resolves from cwd, so run from a lane worktree it can pick a DIFFERENT worktree's
 * package — and this file exports nothing: it reads `DATABASE_URL` and DELETES rows.
 * `scripts/lane-db.sh` exports that URL before invoking pnpm, so the wrong resolution
 * there means another worktree's seed applied to this lane's database, which looks
 * exactly like a clean reset. LANES.md § "Every lane isolates its own resources".
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
import { PUBLISHED_LEGAL_SET, SUPPORT_CONFIG } from './legalSeed';
import { legalDocumentSet, supportConfig, supportTopic } from './schema/legal';
import { boost, happyHour } from './schema/promotion';
import { branch, salon } from './schema/salon';
import { artist, type ArtistWindows } from './schema/artist';
import { auditLog } from './schema/audit';
import { ledgerEntry } from './schema/ledger';
import { member, memberConsentEvent } from './schema/member';
import { platformAdmin } from './schema/platformAdmin';
import { product } from './schema/product';
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
const PLATFORM_PASSWORD = 'yousef-dev-password';
const STAFF_PIN = '2468';
const HESSA_PIN = '1357';
const SCANNER_DEVICE = 'DEV-SCANNER-01';

/**
 * ============================================================================
 * TWO MODES, BECAUSE "SEED" AND "RESET" ARE TWO THINGS AND THIS FILE DID BOTH
 * UNCONDITIONALLY ON A DATABASE FOUR LANES SHARE.
 * ============================================================================
 *
 * What that cost, concretely, before this flag existed:
 *
 *   - Lane B lost a scanner session mid-test and spent an afternoon chasing a
 *     401 against a JWT that was still valid for another thirteen minutes. The
 *     token was fine. Its `session` row had been deleted by somebody else's
 *     `pnpm db:seed` in another terminal.
 *   - A trunk integration check lost 65 e2e specs to the same DELETE and read
 *     as a regression until `sessions: 0` explained it.
 *
 * Neither is a bug in the thing that broke, and that is what makes it worth a
 * flag rather than a warning in a README: the failure surfaces far away from
 * the command that caused it, in someone else's terminal, as a symptom that
 * looks like an auth defect.
 *
 * `SEED_RESET=1` — THE DEFAULT. Restores the fixture world: clears the transient
 * money-path state and puts Dana back on 24.500 / 5 visits / Silver. This is
 * what CI wants, what a local suite run wants, and what makes Lane D's specs
 * repeatable. It is destructive by design and now says so.
 *
 * `SEED_RESET=0` — ensures the fixture ROWS exist and touches no live state.
 * The mode a shared development database has needed all along. Balances,
 * transactions, ledger entries, wallet tokens and open top-up intents are left
 * exactly as they are; only rows that are missing are created.
 *
 * `SEED_RESET_SESSIONS=1` — SEPARATE, AND OFF EVEN WHEN SEED_RESET IS ON.
 *
 * Sessions are not money-path state, and nothing in these fixtures depends on
 * there being no sessions. The lockout state a test actually needs cleared —
 * `pinFailedAttempts`, `pinLockedUntil` — is already reset by the staff upserts
 * above, without touching a single credential anyone is holding. The only thing
 * clearing `session` and `pin_attempt` buys is ending the per-device PIN
 * rate-limit window early, which is a real need perhaps twice a week and is
 * worth typing out loud on those two occasions.
 *
 * So the default is now: a developer who runs `pnpm db:seed` out of habit
 * cannot sign anybody out.
 */
const RESET = (process.env.SEED_RESET ?? '1') !== '0';
const RESET_SESSIONS = process.env.SEED_RESET_SESSIONS === '1';

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
  const [memberHash, staffHash, pinHash, hessaPinHash, platformHash] = await Promise.all([
    hashSecret(MEMBER_PASSWORD),
    hashSecret(STAFF_PASSWORD),
    hashSecret(STAFF_PIN),
    hashSecret(HESSA_PIN),
    hashSecret(PLATFORM_PASSWORD),
  ]);

  /**
   * ------------------------------------------------- the platform owner ----
   *
   * `PLT-001` / Yousef, and the id is chosen rather than invented: the two
   * `actor_kind = 'platform_admin'` audit rows this seed has always written use
   * `actor_id = 'PLT-001'`, from the design's own row ("Yousef · AVO platform ·
   * Wallet adjusted"). `audit_log.actor_id` is a SOFT reference with no foreign
   * key, so those rows worked while no such admin existed — and now that one does,
   * matching the id makes the fixture's history and the live actor the same
   * person instead of two Yousefs.
   *
   * SEEDED BEFORE ANY SESSION, because `session.platform_admin_id` references it.
   *
   * `onConflictDoUpdate` on the hash for the reason the member rows document:
   * every developer database predates migration 0028, so DO NOTHING would be a
   * no-op on a warm database and the console would be unreachable while the seed
   * printed success. The perms are in the SET too — `platform_admin_owner_holds_everything`
   * means an owner row cannot be partially granted, so a future ninth section
   * added to the table would leave this row violating its own CHECK unless the
   * seed reasserts it.
   */
  await db
    .insert(platformAdmin)
    .values({
      id: 'PLT-001',
      name: 'Yousef',
      handle: 'yousef',
      passwordHash: platformHash,
      role: 'owner',
      owner: true,
      // Spelled out rather than derived from PLATFORM_ROLE_PRESETS by string
      // manipulation: a `Record<string, boolean>` cast into drizzle's insert
      // values is a cast, and tsc naming a missing column is worth more here than
      // nine lines saved. `platform_admin_owner_holds_everything` is the second
      // check on the same thing.
      permAnalytics: true,
      permActivity: true,
      permSalons: true,
      permAccounts: true,
      permAdmins: true,
      permControls: true,
      permApprovals: true,
      permPolicies: true,
      permAudit: true,
    })
    .onConflictDoUpdate({
      target: platformAdmin.id,
      set: {
        passwordHash: platformHash,
        permAnalytics: true,
        permActivity: true,
        permSalons: true,
        permAccounts: true,
        permAdmins: true,
        permControls: true,
        permApprovals: true,
        permPolicies: true,
        permAudit: true,
        active: true,
      },
    });

  /**
   * A SECOND CONSOLE ADMIN WITH LESS AUTHORITY, and it is the same fixture shape
   * as ST-002 on the merchant side: `authority.test.ts` can only prove a section
   * gate exists if some credential is refused by it. `PLT-002` / Mariam is the
   * design's own second row — "Mariam K. · analyst" with analytics and activity
   * only — so `perm_approvals` and `perm_policies` are false on a real, signable
   * account rather than only on a hypothetical one.
   */
  await db
    .insert(platformAdmin)
    .values({
      id: 'PLT-002',
      name: 'Mariam K.',
      handle: 'mariam.k',
      passwordHash: platformHash,
      role: 'analyst',
      owner: false,
      permAnalytics: true,
      permActivity: true,
      permSalons: false,
      permAccounts: false,
      permAdmins: false,
      permControls: false,
      permApprovals: false,
      permPolicies: false,
      permAudit: false,
    })
    .onConflictDoUpdate({
      target: platformAdmin.id,
      set: { passwordHash: platformHash, active: true },
    });

  /**
   * A THIRD ADMIN, AND SHE EXISTS TO MAKE A GUARD REACHABLE.
   *
   * `DELETE /v1/platform/admins/{id}` refuses an admin removing her OWN account —
   * the console's `admins` section is the only route back in, so a self-removal
   * locks a section of the product behind a row nobody can edit. Real property.
   *
   * And it could not be executed. The owner is refused one line earlier by a
   * different rule, and the only other signable admin was the analyst, who has no
   * `admins` permission and so never reaches the handler. So the branch was
   * unreachable — the shape this repository has already paid for twice, in
   * `heldDepositFils` sitting at 0 until bookings landed and in the no-show runner
   * that STATUS.md records as never once executed by a spec. "A branch that cannot
   * execute cannot be wrong, and cannot be tested either."
   *
   * `admin` is the design's own role — "Full admin — everything" in the Admins
   * editor's select — so this is a fixture of something the product ships rather
   * than a test-only account. It is also the second full-authority credential the
   * console needs for any two-reviewer case.
   */
  await db
    .insert(platformAdmin)
    .values({
      id: 'PLT-003',
      name: 'Salem A.',
      handle: 'salem.a',
      passwordHash: platformHash,
      role: 'admin',
      owner: false,
      permAnalytics: true,
      permActivity: true,
      permSalons: true,
      permAccounts: true,
      permAdmins: true,
      permControls: true,
      permApprovals: true,
      permPolicies: true,
      permAudit: true,
    })
    .onConflictDoUpdate({
      target: platformAdmin.id,
      set: { passwordHash: platformHash, active: true, permAdmins: true },
    });

  /**
   * THE LEGAL SET FIRST, BEFORE ANY MEMBER.
   *
   * Not because a foreign key demands it — `member.policy_version` is a plain
   * integer — but because the ordering states the dependency that actually
   * exists. Non-negotiable #10 makes the stamped version a claim about which
   * words a customer agreed to, and both seeded members carry
   * `policyVersion: 3`. Seeding them before the set they point at is how every
   * member row came to reference a document the API could not produce.
   *
   * `onConflictDoNothing` on the version, never an update. A published set is
   * immutable — that is the whole reason every version is kept — so a re-run of
   * this seed must not quietly rewrite the text a stored consent refers to.
   * Republishing is an INSERT at a new version, from the owner console.
   */
  await db
    .insert(legalDocumentSet)
    .values({
      version: PUBLISHED_LEGAL_SET.version,
      effectiveFrom: PUBLISHED_LEGAL_SET.effectiveFrom,
      /**
       * `"2026-06-01T09:00"` in the design file is a NAIVE wall clock, and
       * `new Date()` on a naive string resolves it in the PROCESS zone. That
       * makes the published timestamp a different instant on every machine
       * that runs this seed — it came out as 04:00Z here and would be 09:00Z in
       * CI, for a value clients render as "published at". Same class of bug as
       * the one `salon.timezone` exists to prevent, and the same fix: name the
       * zone instead of inheriting one. AVO publishes from Kuwait, UTC+3, no
       * DST.
       */
      publishedAt: new Date(`${PUBLISHED_LEGAL_SET.publishedAt}:00+03:00`),
      publishedBy: PUBLISHED_LEGAL_SET.publishedBy,
      docs: PUBLISHED_LEGAL_SET.docs,
    })
    .onConflictDoNothing({ target: legalDocumentSet.version });

  // AVO's support channels and the Contact us topic list. Unlike the legal set
  // these are live on save — api-contract.md: "unlike legal documents there is
  // no draft/publish step, because nothing here is a legal representation" — so
  // the seed keeps them current rather than leaving the first write standing.
  await db
    .insert(supportConfig)
    .values({ id: 'avo', ...SUPPORT_CONFIG.channels })
    .onConflictDoUpdate({
      target: supportConfig.id,
      set: { ...SUPPORT_CONFIG.channels, updatedAt: new Date() },
    });

  for (const [position, topic] of SUPPORT_CONFIG.topics.entries()) {
    await db
      .insert(supportTopic)
      .values({ id: topic.id, route: topic.route, en: topic.en, ar: topic.ar, position })
      .onConflictDoUpdate({
        target: supportTopic.id,
        // `route` is included on purpose: it is AVO's answer to "who handles
        // this", and a fixture drifting from design/avo-promotions.js would
        // make non-negotiable #11 untestable against the real routing table.
        set: {
          route: topic.route,
          en: topic.en,
          ar: topic.ar,
          position,
          active: true,
          updatedAt: new Date(),
        },
      });
  }

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
      /**
       * BOTH MODULES ON, and they are the fields of Amara's configuration this
       * seed changes — booking when booking landed, shop when the shop did, for
       * one reason stated once.
       *
       * The modules default OFF for a real salon — AVO-Beauty-Product-Description-v2.md
       * § Settings, "module toggles (Booking, Shop — both default OFF)" — and the
       * COLUMNS keep that default. Amara is the fixture every lane drives, and
       * both `POST /bookings` and `POST /orders` refuse a salon whose module is
       * off, so leaving them false would make the whole of phase 6 unreachable in
       * development and start every proof run with a PATCH.
       *
       * SAL-LUMIERE below stays OFF on both deliberately, which is what keeps the
       * refusals themselves testable: two salons, one with the module and one
       * without, is the only fixture shape that can prove a gate exists rather
       * than that it is merely absent.
       *
       * WHAT THIS COMMENT USED TO CLAIM, AND WHY IT WAS WRONG. It said Lumière
       * "has no products either, so `shop_not_enabled` and an empty catalog are
       * separately reachable". Neither half held. `shop_not_enabled` was raised
       * only by `POST /orders`; `GET /salons/{id}/products` had no module check at
       * all, so with the shop off the catalogue answered 200 with the full list
       * and the refusal was unreachable on the read. And because Lumière is off
       * AND empty, its two possible causes were indistinguishable anyway. The
       * sentence is what made the missing gate look deliberate — it asserted a
       * property of a file it was not checked against, which is this build's most
       * expensive recurring defect. The gate now exists: `routes/salons.ts`
       * § `assertShopReadable`.
       *
       * WHAT IS STILL NOT REACHABLE FROM THIS SEED, stated rather than implied: an
       * EMPTY CATALOGUE ON AN OPEN SHOP. That needs `module_shop = true` with zero
       * products, and no seeded salon is shaped that way — Amara is on with three
       * products, Lumière is off with none. So Lumière proves the refusal and
       * nothing here proves the wallet's `shopEmpty*` copy. A third fixture, or a
       * test that clears Amara's catalogue, is owed; it is named here rather than
       * asserted away.
       */
      moduleBooking: true,
      moduleShop: true,
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
      // Spelled out rather than left to the column default, because the two
      // lines below it are meaningless without it: "10:00" is a string until
      // something says which clock. Migration 0010.
      timezone: 'Asia/Kuwait',
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
    // The Arabic columns and the two module flags are in the SET; the rest of
    // Amara's configuration is left alone deliberately, because it is a salon a
    // developer may have edited through `PATCH /salons/:id` while working and
    // this insert is not the place that resets it.
    //
    // `module_booking` and `module_shop` are in the SET for exactly the reason
    // `name_ar` is. Every developer and CI database already holds an Amara row
    // from before those features existed, with the module off; DO NOTHING there
    // would leave the whole of phase 6 unreachable on every warm database while
    // the seed printed success. That is the same silent-claim failure the
    // paragraph above describes, and it is worse here because the symptom is a
    // 409 on a route the fixture is supposed to make reachable.
    .onConflictDoUpdate({
      target: salon.id,
      set: {
        nameAr: 'أمارا',
        stampRewardAr: 'تصفيف شعر مجاني',
        moduleBooking: true,
        moduleShop: true,
      },
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

  // The Book flow's service list, in both languages. SV-05 has NO Arabic name
  // deliberately, for the reason migration 0006 gives about the branch fixture:
  // a `nameAr ?? name` fallback exercised only by rows that all have a
  // translation never proves the null path, and the "stringify bug" — a NULL
  // reaching a client as the four-character string "null" — is invisible until
  // a row genuinely holds one.
  //
  // `onConflictDoUpdate` rather than `DoNothing`: these rows predate migration
  // 0022, so a database seeded before it would keep five NULL Arabic names and
  // the Book flow would look exactly as broken as it did before the column
  // existed.
  await db
    .insert(service)
    .values([
      { id: 'SV-01', salonId: SALON_ID, name: 'Blow-dry', nameAr: 'تجفيف بالسشوار', priceFils: fils(8000) },
      { id: 'SV-02', salonId: SALON_ID, name: 'Cut & style', nameAr: 'قص وتصفيف', priceFils: fils(15000) },
      { id: 'SV-03', salonId: SALON_ID, name: 'Colour — roots', nameAr: 'صبغة الجذور', priceFils: fils(25000) },
      { id: 'SV-04', salonId: SALON_ID, name: 'Manicure', nameAr: 'مانيكير', priceFils: fils(6000) },
      { id: 'SV-05', salonId: SALON_ID, name: 'Treatment', nameAr: null, priceFils: fils(12500) },
    ])
    .onConflictDoUpdate({
      target: service.id,
      set: { nameAr: sql`excluded.name_ar` },
    });

  /**
   * The shop catalog — `packages/mock/src/fixtures.ts § products`, exactly.
   *
   * BYTE-IDENTICAL TO THE MOCK'S THREE ROWS, ids included, for the reason the
   * promotion fixtures below are: three lanes build against the mock and one
   * against this, and a seed that invented its own catalog would mean the wallet's
   * Shop tab showed different products depending on which base URL it happened to
   * be pointed at. `AVO Wallet Home.dc.html` draws five products of its own with
   * descriptions and colour swatches; those are prototype presentation — there is
   * no field on `product` to hold either, and `ProductSchema` declares none — so
   * the mock's list is the one that is actually a fixture.
   *
   * THIS CLOSES A NAMED GAP AND WILL TURN ONE SPEC RED ON PURPOSE.
   * `e2e/contract.test.ts` carries a placeholder — "ProductSchema is UNWITNESSED
   * — the seed creates no product for it to be tested against" — which asserts
   * `items` is EMPTY and tells whoever seeds one to turn the real probe on:
   *
   *     'A product now exists, so ProductSchema finally has a live sample. Move
   *      GET /salons/{id}/products into probes() with requireNonEmpty: ["items"]
   *      and delete this spec — it was only ever a placeholder for a shape
   *      nothing could witness.'
   *
   * That file is lane D's column, so this is the seed doing its half and saying
   * so. It is a deliberate red, not a regression.
   *
   * `onConflictDoNothing`, unlike the services above: there is no later column to
   * backfill, and a developer who has repriced a product through the Shop editor
   * while working should not have it reset by a reseed. Nothing about these rows
   * predates the migration that created them.
   */
  await db
    .insert(product)
    .values([
      { id: 'PR-01', salonId: SALON_ID, name: 'Argan hair oil 100ml', priceFils: fils(8500) },
      { id: 'PR-02', salonId: SALON_ID, name: 'Repair mask', priceFils: fils(12000) },
      { id: 'PR-03', salonId: SALON_ID, name: 'Heat protect spray', priceFils: fils(6750) },
    ])
    .onConflictDoNothing();

  // ---------------------------------------------------------- promotions ----
  //
  // packages/mock/src/fixtures.ts § promotions, exactly. Lane D's specs read
  // this set and assert on the SHAPE — days/from/to present, no `live` flag —
  // so a seed that invented its own windows would be testing something nobody
  // designed.
  //
  // WHAT THESE TWO FIXTURES ARE FOR, which is not obvious from the values:
  //
  //   HH-01  all branches, Sun/Mon/Tue 16:00-18:00, x2visit, ON.
  //          The live-window case, and the one that expires ON ITS OWN at 18:00
  //          with no push, no poll and no server tick — because nothing stores
  //          that it is live. It just stops satisfying the predicate.
  //
  //   HH-02  Salmiya only, Thursday 10:00-13:00, topup10, OFF.
  //          The `on: false` case. It is INSIDE its own window for three hours
  //          every Thursday and must never apply — proof that `on` is an input
  //          to the shared predicate rather than a second liveness concept.
  //
  // Neither of them adds a top-up bonus in practice: HH-01 multiplies visits and
  // HH-02 is off. That is the fixture's design, not a convenience — it is what
  // lets Lane D's `bonusFils === tier% of amount` sweep stay a statement about
  // the tier ladder.
  await db
    .insert(happyHour)
    .values([
      {
        id: 'HH-01',
        salonId: SALON_ID,
        branchId: null, // the wire's "all"
        days: [0, 1, 2],
        from: '16:00',
        to: '18:00',
        reward: 'x2visit',
        on: true,
        notify: true,
      },
      {
        id: 'HH-02',
        salonId: SALON_ID,
        branchId: BRANCH_SALMIYA,
        days: [4],
        from: '10:00',
        to: '13:00',
        reward: 'topup10',
        on: false,
        notify: false,
      },
    ])
    // Reset to the fixture on every run, like the member balances above: a
    // developer who switched HH-01 off through the dashboard must not leave the
    // next test run asserting against her state.
    .onConflictDoUpdate({
      target: happyHour.id,
      set: {
        branchId: sql`excluded.branch_id`,
        days: sql`excluded.days`,
        from: sql`excluded."from"`,
        to: sql`excluded."to"`,
        reward: sql`excluded.reward`,
        on: sql`excluded."on"`,
        notify: sql`excluded.notify`,
      },
    });

  await db
    .insert(boost)
    .values([
      {
        salonId: SALON_ID,
        branchId: BRANCH_SALMIYA,
        visit: 1,
        topup: 0,
        stamp: 1,
        publishedAt: new Date('2026-08-10T09:00:00+03:00'),
        publishedBy: 'Noura',
      },
      {
        salonId: SALON_ID,
        branchId: BRANCH_KUWAIT_CITY,
        visit: 2,
        topup: 10,
        stamp: 1,
        publishedAt: new Date('2026-08-10T09:00:00+03:00'),
        publishedBy: 'Noura',
      },
    ])
    .onConflictDoUpdate({
      target: [boost.salonId, boost.branchId],
      set: {
        visit: sql`excluded.visit`,
        topup: sql`excluded.topup`,
        stamp: sql`excluded.stamp`,
        publishedAt: sql`excluded.published_at`,
        publishedBy: sql`excluded.published_by`,
      },
    });

  // ---------------------------------------------------------- staff users ----
  //
  // BEFORE THE ARTISTS, AND THAT ORDER IS LOAD-BEARING.
  //
  // `artist.staff_user_id` references `staff_user`, and AR-003 (Hessa) carries
  // 'ST-002'. These two inserts used to sit 132 lines BELOW the artist insert,
  // which works on every database that has been seeded before and fails on a
  // genuinely empty one:
  //
  //     insert or update on table "artist" violates foreign key constraint
  //     "artist_staff_user_id_staff_user_id_fk"
  //
  // It went unseen for exactly that reason. Every developer database and every
  // local run already held ST-002 from a previous seed, so the only place the
  // ordering was ever exercised was CI, on a fresh database — where it had been
  // failing. A seed is only correct against an empty schema; a warm one cannot
  // tell you anything about insert order, because the rows are already there.
  //
  // This file is now in dependency order throughout: salon → branch → service →
  // promotions → staff_user → artist → member → the money fixtures.

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
        // Same reasoning as the member below: the credentials this script
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
      //
      // THE MONEY FIELDS FOLLOW `SEED_RESET`; THE CREDENTIAL DOES NOT.
      // Rewriting a balance while `SEED_RESET=0` leaves the ledger untouched
      // would make `member.balance_fils` disagree with `sum(ledger_entry)` —
      // the one reconciliation this schema exists to keep true, and the one
      // `db:verify` section 5 now asserts rather than trusting. The password is
      // not money and is always restored, because the line this script prints
      // has to be a line that works.
      set: RESET
        ? {
            balanceFils: fils(32500),
            visits: 6,
            tier: 'silver',
            stamps: null,
            passwordHash: memberHash,
          }
        : { passwordHash: memberHash },
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
      // Same split as Dana above: money follows `SEED_RESET`, the credential
      // always gets restored.
      set: RESET
        ? {
            balanceFils: fils(2500),
            visits: 1,
            tier: 'bronze',
            stamps: null,
            passwordHash: memberHash,
          }
        : { passwordHash: memberHash },
    });

  /**
   * ------------------------------------------- MARKETING CONSENT, SEEDED ----
   *
   * WITHOUT THIS, NO CAMPAIGN CAN REACH ANYBODY, and that is not a bug in the
   * campaign code — it is `services/consent.ts`'s rule working as written: "NO
   * EVENT AT ALL MEANS NO CONSENT. Not 'unknown', not 'assume yes'. A member who
   * predates this table has never been asked, and inferring a grant from silence
   * is the one answer that cannot be defended afterwards."
   *
   * Both seeded members predate the signup path that records consent, so
   * `member_consent_event` was EMPTY on every database, every audience resolved to
   * zero people, and every campaign would have held on "nobody is in this
   * audience". Correct, and useless as a fixture: the delivery path, the weekly
   * cap and the monthly cap would all have been unreachable branches — the same
   * shape as `heldDepositFils` sitting at 0 until bookings landed, which is how a
   * void came to under-refund a customer for a whole build.
   *
   * TWO MEMBERS, TWO ANSWERS, AND 8843 HAS A HISTORY. Dana granted at signup.
   * Reem granted at signup and WITHDREW from her Account screen afterwards, which
   * is two rows: consent is append-only, so a withdrawal is a new event saying
   * `granted: false` and the newest event decides. That gives the audience filter
   * a real excluded member rather than a hypothetical one, and it exercises the
   * half of `grantedMarketingConsent` that a LEFT JOIN with `granted IS NOT FALSE`
   * would silently invert.
   *
   * So `audience: 'all'` at Amara is exactly one person, and that is a true
   * statement about this fixture rather than an accident.
   *
   * Guarded on absence rather than `SEED_RESET`: `member_consent_event` has UPDATE
   * and DELETE revoked from the application role and is not in the destructive
   * block below, so a reseed must not append a second grant on top of a
   * developer's withdrawal and silently opt her back in.
   */
  const [{ consentRows } = { consentRows: 0 }] = (await db.execute(
    sql`SELECT count(*)::int AS "consentRows" FROM member_consent_event`,
  )) as unknown as Array<{ consentRows: number }>;

  if (consentRows === 0) {
    await db.insert(memberConsentEvent).values([
      {
        memberId: '8842',
        salonId: SALON_ID,
        kind: 'marketing_offers',
        granted: true,
        source: 'signup',
        policyVersion: 3,
        createdAt: new Date(Date.now() - 7_200_000),
      },
      {
        memberId: '8843',
        salonId: SALON_ID,
        kind: 'marketing_offers',
        granted: true,
        source: 'signup',
        policyVersion: 3,
        createdAt: new Date(Date.now() - 7_200_000),
      },
      {
        /**
         * The withdrawal, with an EXPLICIT LATER TIMESTAMP.
         *
         * All three rows above would otherwise share `now()` — the transaction
         * timestamp — and that tie is what migration 0029 exists for: with a grant
         * and a withdrawal tied, `ORDER BY created_at DESC` returned the grant, so
         * this fixture originally opted Reem back in. `seq` settles it now, and the
         * timestamp is set anyway because a withdrawal genuinely happens after the
         * signup it reverses, and a fixture that reads as simultaneous is a fixture
         * that tests the tiebreak instead of the rule.
         */
        memberId: '8843',
        salonId: SALON_ID,
        kind: 'marketing_offers',
        granted: false,
        source: 'wallet_account',
        policyVersion: 3,
        createdAt: new Date(Date.now() - 3_600_000),
      },
    ]);
  }

  // ------------------------------------------------ the destructive part ----
  //
  // Everything above this line CREATES fixture rows and is safe to run against
  // any database at any time. Everything below it DELETES other people's work,
  // which is why it is behind `SEED_RESET` — see the flag's comment at the top
  // of this file for the two afternoons that bought it.
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
  if (RESET) {
    await db.execute(sql`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_is_immutable`);
    await db.execute(sql`ALTER TABLE gateway_event DISABLE TRIGGER gateway_event_no_delete`);
    try {
      await db.execute(sql`DELETE FROM receipt_job`);
      await db.execute(sql`DELETE FROM ledger_entry`);
      /**
       * BEFORE `transaction`, and that ordering is the same load-bearing kind as
       * the artist/staff_user one 300 lines above.
       *
       * `booking.hold_transaction_id` is NOT NULL and ON DELETE restrict, and
       * `settled_transaction_id` is restrict too. A booking is a money row that
       * OWNS a transaction; clearing transactions first fails with a foreign key
       * violation on a database where anyone has ever booked. `merchant_notification`
       * has no such reference, but a notification about a booking that no longer
       * exists is a bell nobody can act on, so it goes with it.
       */
      await db.execute(sql`DELETE FROM booking`);
      await db.execute(sql`DELETE FROM merchant_notification`);
      await db.execute(sql`DELETE FROM idempotency_key`);
      await db.execute(sql`DELETE FROM wallet_token`);
      // Order follows the restricting references: event → intent → transaction.
      await db.execute(sql`DELETE FROM gateway_event`);
      await db.execute(sql`DELETE FROM topup_intent`);
      await db.execute(sql`DELETE FROM sandbox_gateway_payment`);
      // `loyalty_event.transaction_id` is ON DELETE RESTRICT, so the climbs a
      // charge produced have to go before the charge does.
      await db.execute(sql`DELETE FROM loyalty_event`);
      /**
       * `shop_order_line.transaction_id` is ON DELETE restrict as well, so the
       * lines of an order have to go before the order does — the same reason
       * `booking` and `loyalty_event` are cleared above rather than below.
       * Without this, `DELETE FROM transaction` fails with a foreign key
       * violation on any database where a customer has ever bought a bottle of
       * anything.
       *
       * No trigger to disable. `shop_order_line` is append-only for `avo_app`
       * only, by GRANT — migration 0027 says why the ledger's TRUNCATE trigger
       * has no counterpart here — and the seed runs as the owner.
       */
      await db.execute(sql`DELETE FROM shop_order_line`);
      await db.execute(sql`DELETE FROM transaction`);

      /**
       * SESSIONS ARE BEHIND THEIR OWN FLAG, AND IT IS OFF EVEN HERE.
       *
       * This is the DELETE that signed Lane B out mid-test and cost a trunk
       * integration check 65 specs. It is not money-path state, nothing in
       * these fixtures depends on its absence, and the lockout state a test
       * needs cleared (`pinFailedAttempts`, `pinLockedUntil`) is already reset
       * by the staff upserts above without invalidating anybody's credential.
       *
       * What it does buy is ending the per-device PIN rate-limit window early —
       * a real need, occasionally, and one worth asking for by name.
       */
      if (RESET_SESSIONS) {
        await db.execute(sql`DELETE FROM session`);
        await db.execute(sql`DELETE FROM pin_attempt`);
      }

      // Windows a developer or a proof run added through the dashboard. Removed
      // AFTER `transaction`, because `transaction.promotion_id` is ON DELETE
      // restrict and a window that paid something out is not deletable until the
      // rows that reference it are gone — which is the guarantee working, not an
      // obstacle. HH-01 and HH-02 are the fixture and are reasserted above.
      await db.execute(
        sql`DELETE FROM happy_hour WHERE salon_id = ${SALON_ID} AND id NOT IN ('HH-01', 'HH-02')`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE gateway_event ENABLE TRIGGER gateway_event_no_delete`);
      await db.execute(sql`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_is_immutable`);
    }
  }

  // -------------------------------------------------- the opening balances ----
  //
  // WITHOUT THIS BLOCK THE LEDGER DOES NOT RECOMPUTE THE WALLET, AND THREE
  // SEPARATE COMMENTS IN THIS CODEBASE SAID IT DID.
  //
  // `member.balance_fils` is a cached aggregate. `schema/ledger.ts` states the
  // property that makes it defensible, and states it as the reason the table
  // exists at all:
  //
  //     SELECT sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END)
  //     FROM ledger_entry WHERE account = 'member_wallet' AND member_id = $1;
  //
  // The fixtures broke that on their first line. Both members were INSERTed with
  // a balance already on the row — 32.500 and 2.500 — and no entry saying where
  // it came from, so the sum was short by exactly the opening balance before
  // anybody touched anything. `sum(ledger_entry)` did not recompute the wallet;
  // it recomputed the wallet MINUS the part the fixture invented.
  //
  // It is a footgun aimed at money tests specifically. The next person to write a
  // reconciliation spec either asserts the sum and watches it fail on a clean
  // database, or discovers the discrepancy and "fixes" a drift that was never
  // real. It is also why the reconciliation had to be described in terms of
  // `balance_after_fils` — a workaround for this gap that read like a design.
  //
  // AN OPENING BALANCE IS A REAL CREDIT, so it gets a real entry. The ledger is
  // the record of how a balance came to be; a balance with no originating entry
  // is a hole in that record, not a fixture convenience.
  //
  // WHY `adjustment` AND NOT `topup`. The kind had to keep the invariant without
  // distorting a report, and `transaction.kind` is exactly what the merchant
  // reports filter on: services/metrics.ts sums `kind = 'topup'` for the top-up
  // tile and `kind = 'charge'` for revenue. A seeded `topup` would inflate a
  // salon's top-up volume — and its commission — with money that predates the
  // dataset and was never collected from anyone. `adjustment` is counted by
  // neither tile, is the kind the enum carries for money that moved for a reason
  // that is not a sale or a load, and satisfies
  // `transaction_amount_sign_matches_kind` (adjustment <> 0).
  //
  // WHY THE COUNTERPART IS `gateway_clearing`. Double entry needs a source, and
  // the fixture's story is that she topped up at some point before this dataset
  // begins. `gateway_clearing` is where money from outside enters this ledger —
  // it is the account a settled top-up debits (services/topup.ts) — so the pair
  // reads the same way a real top-up does. Nothing aggregates ledger accounts for
  // a report; only `transaction.kind` does, which is why the kind is the field
  // that had to be chosen carefully and the account did not.
  //
  // WRITTEN BEFORE TX-9021 so `seq` tells the story in order: the wallet is
  // funded, then it is charged. And guarded per member, so `SEED_RESET=0` on a
  // database that already has these entries does not write a second set —
  // `ledger_entry` has no natural key to conflict on, and the immutability
  // trigger means a duplicate could never be cleaned up afterwards.
  const OPENING_BALANCES = [
    { memberId: '8842', openingFils: 32500 },
    { memberId: '8843', openingFils: 2500 },
  ] as const;

  for (const { memberId, openingFils } of OPENING_BALANCES) {
    const openingTxId = `TX-OPEN-${memberId}`;
    const [{ present } = { present: 0 }] = (await db.execute(
      sql`SELECT count(*)::int AS present FROM "transaction" WHERE id = ${openingTxId}`,
    )) as unknown as Array<{ present: number }>;
    if (present > 0) continue;

    const openedAt = new Date();
    await db.insert(transaction).values({
      id: openingTxId,
      memberId,
      salonId: SALON_ID,
      branchId: BRANCH_SALMIYA,
      kind: 'adjustment',
      amountFils: fils(openingFils),
      // No `method`: nothing was collected through a payment method here. A
      // method on this row would be a claim about how money arrived.
      status: 'settled',
      reference: `AVO-OPEN-${memberId}`,
      note: 'Opening fixture balance',
      createdAt: openedAt,
      settledAt: openedAt,
    });
    await db.insert(ledgerEntry).values([
      {
        transactionId: openingTxId,
        salonId: SALON_ID,
        memberId,
        account: 'member_wallet',
        direction: 'credit',
        amountFils: fils(openingFils),
        // Her balance at this point in the story. For 8842 that is the
        // pre-charge 32.500; TX-9021 below takes her to 24.500.
        balanceAfterFils: fils(openingFils),
      },
      {
        transactionId: openingTxId,
        salonId: SALON_ID,
        memberId: null,
        account: 'gateway_clearing',
        direction: 'debit',
        amountFils: fils(openingFils),
      },
    ]);
  }

  // ------------------------------------------------------------ TX-9021 ----
  //
  // Lane D's permission specs void `TX-9021` by name and assert it is a settled
  // −8.000 charge in Dana's feed. It is a mock fixture id, so a real database has
  // no counterpart unless one is made — and making one carelessly would leave a
  // money row with no ledger behind it, which is exactly the state `ledger_entry`
  // exists to prevent.
  //
  // So it is seeded the way the API would have written it: Dana is funded to
  // 32.500 by the opening entry above, this charge posts a balanced pair, and her
  // balance lands on the 24.500 the fixtures specify. The ledger reconciles to the
  // balance, and `SELECT sum(...) FROM ledger_entry` recomputes the wallet from
  // first principles — which became true only when the opening balances above got
  // entries of their own. This comment used to make that claim while the fixture
  // contradicted it; `db:verify` section 5 now asserts it instead of asserting it in
  // prose.
  //
  // It is dated now rather than backdated so it sits inside the 15-minute void
  // window; a two-day-old charge is not voidable, it is a reimbursement.
  //
  // WRITTEN ONLY IF IT IS NOT ALREADY THERE. Under `SEED_RESET=1` the block
  // above has just deleted it, so this always runs and always writes a fresh
  // one inside a fresh void window. Under `SEED_RESET=0` nothing was deleted,
  // the row survives from the last reset, and re-inserting it would raise a
  // primary key violation — the seed would fail on the safe mode and only on
  // the safe mode, which is the worst possible place to put a crash.
  //
  // The trade-off is stated rather than hidden: on a database last reset more
  // than fifteen minutes ago, TX-9021 is outside its void window and Lane D's
  // void specs will not pass against it. That is what `SEED_RESET=1` is for.
  const [{ present: hasCharge } = { present: 0 }] = (await db.execute(
    sql`SELECT count(*)::int AS present FROM "transaction" WHERE id = 'TX-9021'`,
  )) as unknown as Array<{ present: number }>;

  if (hasCharge === 0) {
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
    // The charge lands her on the fixture balance and visit count. Guarded by
    // the same condition: without it, a `SEED_RESET=0` run would reach past the
    // untouched ledger and rewrite the balance anyway.
    await db
      .update(member)
      .set({ balanceFils: fils(24500), visits: 5 })
      .where(eq(member.id, '8842'));
  }

  // ------------------------------------------------ audit log fixtures ----
  //
  // Three rows the audit-log endpoint cannot be honestly tested without.
  //
  // WRITTEN ONCE, NEVER RESET — AND THE SEED FOUND THAT OUT THE HARD WAY.
  //
  // Every other fixture here is reset on each run: the money tables are cleared
  // above, which for `ledger_entry` and `gateway_event` takes deliberately
  // disabling an immutability trigger. The obvious thing to write for these rows
  // was the same — DELETE the previous fixtures, insert them again — and it
  // fails:
  //
  //     PostgresError: audit_log is append-only: DELETE is not permitted
  //
  // even as the OWNER, because migration 0001 backs the REVOKE with a trigger
  // and no `ALTER TABLE ... DISABLE TRIGGER` is written anywhere for this table.
  // That is the guarantee doing its job against the one caller most likely to
  // erode it by accident, and it is a better demonstration of "append-only, 7
  // years" than any assertion: the seed cannot tidy the audit log, so neither
  // can anything else.
  //
  // So the fixtures are inserted only if they are not already there. Re-running
  // the seed leaves the existing rows exactly as they were written.
  const [{ present } = { present: 0 }] = (await db.execute(
    sql`SELECT count(*)::int AS present FROM audit_log WHERE actor_id = 'PLT-001'`,
  )) as unknown as Array<{ present: number }>;

  if (present === 0) await db.insert(auditLog).values([
    {
      // The design's own row: "Yousef · AVO platform · Wallet adjusted ·
      // +5.000 KD to Noura S. · support request · Owner console".
      //
      // It carries THIS salon's id, which is the whole point — an AVO action on
      // a salon appears in that salon's log, marked. The dashboard's footnote
      // promises it and nothing else in the fixtures produces one.
      salonId: SALON_ID,
      actorKind: 'platform_admin',
      actorId: 'PLT-001',
      actorName: 'Yousef',
      actorRole: 'AVO platform',
      kind: 'money',
      action: 'Wallet adjusted',
      detail: '+5.000 KD to Dana A. · support request',
      source: 'owner_console',
      subjectType: 'member',
      subjectId: '8842',
      amountFils: fils(5000),
      metadata: { ticket: 'AVO-2291' },
    },
    {
      // A PLATFORM-level action belonging to no salon. `salon_id` is null, so it
      // must be invisible to every merchant — the `salon_id = $1` predicate
      // excludes null without anyone having to remember to.
      salonId: null,
      actorKind: 'platform_admin',
      actorId: 'PLT-001',
      actorName: 'Yousef',
      actorRole: 'AVO platform',
      kind: 'rules',
      action: 'Commission rates changed',
      detail: 'KNET flat 150 → 175 fils, platform-wide',
      source: 'owner_console',
      subjectType: 'platform',
      subjectId: null,
      metadata: {},
    },
    {
      // ANOTHER SALON'S ROW. Without this, "a merchant cannot read another
      // salon's audit rows" is proved against an empty set and proves nothing.
      salonId: 'SAL-LUMIERE',
      actorKind: 'staff',
      actorId: 'ST-LUM-001',
      actorName: 'Lumiere Manager',
      actorRole: 'manager',
      kind: 'access',
      action: 'Permissions changed',
      detail: 'A name from another salon that must never appear in Amara’s log',
      source: 'merchant',
      subjectType: 'staff_user',
      subjectId: 'ST-LUM-001',
      metadata: {},
    },
  ]);

  // WHICH MODE RAN, ALWAYS, AND FIRST.
  //
  // The destructive mode is the default, which is right for CI and for a local
  // suite run and wrong to leave unsaid: the whole failure this flag exists to
  // prevent was somebody not knowing that `pnpm db:seed` had reached into a
  // database somebody else was using. A line of output is what turns "the API
  // is broken" into "oh, I re-seeded".
  if (RESET) {
    console.log(
      `seeded + RESET — money tables cleared${RESET_SESSIONS ? ', sessions and PIN attempts cleared' : ''}.`,
    );
    if (!RESET_SESSIONS) {
      console.log('  sessions left alone. SEED_RESET_SESSIONS=1 to clear them too.');
    }
    console.log('  on a database someone else is using, run with SEED_RESET=0.');
  } else {
    console.log('seeded (SEED_RESET=0) — fixture rows ensured, no live state touched.');
  }
  /**
   * THE SUMMARY IS READ BACK OUT OF THE DATABASE, NOT ASSERTED FROM A LITERAL.
   *
   * This line used to be the hardcoded string `(24.500 KD, Silver)`, printed
   * whenever `SEED_RESET` was on. That is true only for as long as nothing else
   * in this file changes, and it cost a verification run: the printed summary and
   * the actual row are two claims about the same number, and the reader trusts
   * the one on their screen. Under `SEED_RESET=0` the literal was suppressed
   * entirely, which was honest but unhelpful — the balance is exactly what a
   * developer about to test a charge needs to know, and it is knowable.
   *
   * Reading the row covers both modes with one rule and cannot drift: after a
   * reset it prints what the reset produced, and without one it prints whatever
   * the last charge left. This is the same lesson `passwordHash` taught a few
   * hundred lines above, applied to the money instead of the credential.
   */
  const printed = await db
    .select({
      id: member.id,
      balanceFils: member.balanceFils,
      tier: member.tier,
      visits: member.visits,
    })
    .from(member)
    .where(sql`${member.id} IN ('8842', '8843')`)
    .orderBy(member.id);

  // Three decimals, Western digits — the display boundary rule, and the only
  // place in this script where fils become a human-readable figure.
  const kd = (v: number | bigint) => (Number(v) / 1000).toFixed(3);

  for (const row of printed) {
    const tier = row.tier ? `, ${row.tier[0]!.toUpperCase()}${row.tier.slice(1)}` : '';
    const visits = `${row.visits} visit${row.visits === 1 ? '' : 's'}`;
    console.log(
      `  member  ${row.id} / ${MEMBER_PASSWORD}   (${kd(row.balanceFils)} KD${tier}, ${visits})`,
    );
  }
  console.log(`  web     noura / ${STAFF_PASSWORD}`);
  console.log(`  PIN     noura ${STAFF_PIN} · hessa ${HESSA_PIN} on device ${SCANNER_DEVICE}`);
  console.log(`  console yousef / ${PLATFORM_PASSWORD}       (owner, every section)`);
  console.log(`  console mariam.k / ${PLATFORM_PASSWORD}     (analyst — no approvals, no policies)`);
  console.log(`  console salem.a / ${PLATFORM_PASSWORD}      (full admin, not the owner)`);
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
