/**
 * IS ANY SCHEMA IN `packages/types` NARROWER THAN THE WIRE?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run contract.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four contract drifts have been found on this project. Every one of them was
 * found by a lane walking into it — a screen that would not render, a grid that
 * came back empty — and not by a check. All four were the same defect:
 *
 *   1. `ArtistSchema` declared less than `serialiseArtist` sends.
 *   2. `BookingSchema` had no `changeableUntil`, so the ENTIRE one-hour
 *      cancellation rule was deleted between the server and the screen. Zod does
 *      not fail to type an undeclared field, it STRIPS it: the server sent the
 *      deadline and the contract removed it before any client could read it.
 *   3. `AvailabilitySlotSchema` declared `{time, available, reason?}` against an
 *      API sending `{startsAt, endsAt, local, available, reason}` in an envelope,
 *      and the envelope's `open`, `subtracted`, `artistId`, `timezone` and
 *      `slotMinutes` were stripped with it. `open: false` with an empty `slots`
 *      is how a client tells "she does not work that day" from an error.
 *   4. The fix for (3) made `reason` `.nullable()` but not `.optional()`. The
 *      server OMITS the key on an available slot, so `reason` became required and
 *      EVERY BOOKABLE SLOT FAILED `.parse()` — the whole Book grid. It hid on
 *      today's date, where every slot is already past and therefore carries a
 *      reason, which is exactly why the fix looked correct.
 *
 * Four for four, silent, and each one found downstream of the lane that could
 * have caught it. This file is the check.
 *
 * WHAT IT DOES THAT `safeParse` DOES NOT
 * --------------------------------------
 * `safeParse` going red is the EASY half. It catches (4) and nothing else. The
 * half that has actually bitten is silent stripping, and the only honest test for
 * it is a DEEP COMPARISON OF THE PRE-PARSE RESPONSE AGAINST THE POST-PARSE ONE.
 * See `support/contract-drift.ts`. Both directions are asserted, because (2) and
 * (3) were fields lost and (4) was a field wrongly required.
 *
 * FOUR RULES THIS FILE KEEPS
 * --------------------------
 * 1. NO FIXTURES. Every comparison is against a response lane A's API served
 *    during this run. A recorded response drifts alongside the schema it is meant
 *    to police, and then proves nothing — it is the schema, written twice.
 *
 * 2. NO EMPTY SAMPLES. "No key was dropped" across zero objects is vacuously
 *    true, and `GET /bookings` on a fresh database returns `{items: []}`. So the
 *    probes create real rows first — a settled top-up, a real booking, a real
 *    charge — and every probe declares which arrays must be non-empty for it to
 *    have meant anything. A probe that finds an empty array FAILS.
 *
 * 3. A FUTURE DATE FOR AVAILABILITY. That single choice is the whole difference
 *    between catching (4) and shipping it. There is a spec below whose only job
 *    is to prove the sample contains a slot with `available: true` and NO
 *    `reason` key at all, which is the exact shape that failed.
 *
 * 4. A SHAPE WITH NO SCHEMA IS NAMED, NOT SKIPPED. The bookable-artist row had no
 *    schema at all until an hour after it shipped. The census at the bottom reads
 *    every `app.get` off disk and requires each one to be classified — probed
 *    against a schema, or listed as unmodelled WITH A REASON. A GET added next
 *    month lands in neither list and this file goes red.
 *
 * WHAT IS `knownBug()` HERE
 * -------------------------
 * `packages/types` is not lane D's column, so the drifts this file found on its
 * first run are REPORTED, not fixed. Each is written as the assertion the
 * contract calls for and wrapped in `knownBug()`, so it reports green today and
 * goes red the hour the schema is corrected. Every one is named in the lane
 * report.
 *
 * COVERAGE, HONESTLY STATED. The census is enforced over GET routes. The four
 * POST responses carrying a schema — `POST /bookings`, `POST /topups`,
 * `POST /charges`, `POST /v1/support/tickets` — are probed by name below but not
 * census-enforced, because most writes return an acknowledgement rather than an
 * entity and a census over them would be a list of exemptions.
 *
 * AND THE SHAPES WITH NO SCHEMA AT ALL — the WIRE PINS at the bottom.
 * -------------------------------------------------------------------
 * Rule 4 above says a served shape with no schema is named, not skipped, and for
 * a while naming it was all this file could do. That is not enough for a shape a
 * client is ALREADY BUILT AGAINST. `GET`/`PATCH /members/me/notifications` and
 * `POST`/`DELETE /members/me/deletion` shipped after `packages/types` and have no
 * schema in it; the wallet's Account screen reads all four. A shape with no schema
 * does not stop drifting, it just drifts against the client instead — and with
 * nothing in `packages/types` to compare against, `keyDeltas` has no second side.
 *
 * So the second side is written by hand: the key set the wire serves, declared
 * here, compared BOTH WAYS against a real response. `wireShape` in
 * support/contract-drift.ts explains the two directions and why a `null` leaf is a
 * PRESENT key and not an absent one — `offersConsent.at` is null until she is
 * asked, and an API that omits it instead is a different contract behind an
 * identical screen. Only the shape is pinned, never a value: a pinned value is a
 * fixture, and rule 1 says this file holds none.
 *
 * The pin is a stopgap, and it should lose. The day either shape gets a schema in
 * `packages/types`, delete its pin and add a probe.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { knownBug } from './support/known-bug.js';
import {
  ArtistSchema,
  AvailabilityDaySchema,
  BookableArtistSchema,
  BookingSchema,
  LegalDocumentSetSchema,
  MemberSchema,
  CampaignSchema,
  PlatformMessagingPolicySchema,
  ProductSchema,
  PromotionSetSchema,
  SalonMetricsSchema,
  SalonSchema,
  ServiceSchema,
  StaffUserSchema,
  SupportConfigSchema,
  SupportTicketSchema,
  TopUpIntentPublicSchema,
  TransactionSchema,
  WalletTokenSchema,
  paginated,
} from '../packages/types/dist/index.js';
import {
  type ParsesLikeZod,
  describeDeltas,
  describeParseError,
  discoverGetRoutes,
  keyDeltas,
  wireShape,
} from './support/contract-drift.js';
import {
  A_SERVICE,
  A_STAFF_FULL,
  QA_MEMBER,
  QA_MEMBER_PHONE,
  SALON_A,
  SALON_B,
  attemptScannerSignIn,
  mintWalletTokenFor,
  psql,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
  PLATFORM_OWNER_HANDLE,
  signInPlatform,
} from './support/tenancy-harness.js';

/** Salon A's seeded scanner device and staff. `api/src/db/seed.ts`. */
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';
const A_STAFF_HANDLE = 'noura';
/** Hessa, ST-002 — the ONE staff account wired to an artist row (AR-003). */
const A_ARTIST_STAFF_HANDLE = 'hessa';
const A_ARTIST_STAFF_PIN = '1357';
/** Rana, AR-001. Her week is open six days, so a future date always has a grid. */
const A_ARTIST = 'AR-001';
/** Hessa, AR-003. Nothing in this file books her, so her `subtracted` stays empty. */
const A_QUIET_ARTIST = 'AR-003';

let n = 0;
const key = (label: string) => `contract-${label}-${Date.now()}-${n++}`;

let dashboard = '';
let scanner = '';
let artistScanner = '';
let member = '';
let pinMember = '';
/**
 * The owner console's credential, added 2026-08-19 — and the census spec below is what
 * demanded it. `NEEDS_PLATFORM_CREDENTIAL` excused four routes on the grounds that this
 * harness could not mint a platform principal; the hour `signInPlatform` existed, that
 * spec went red holding its own instructions. Two of the four are now ordinary probes.
 */
let platform = '';

/**
 * A MEMBER OF THIS FILE'S OWN, FOR THE DELETION PIN ONLY.
 *
 * `POST /members/me/deletion` answers 409 while there is credit in the wallet —
 * correctly, non-negotiable #5 makes that balance money the salon owes her — so
 * capturing the 200 shape needs a member at zero. `QA_MEMBER` is not her: this
 * file tops her up and charges her, and zeroing her balance to take one sample
 * would make the order of the writes in `beforeAll` load-bearing. It also STARTS
 * A DELETION CLOCK on whoever it is pointed at, which is not a thing to do to a
 * row another file signs in as.
 *
 * The password hash is copied off `staff_user` rather than pasted, the same way
 * `seedSalonB()` does it: `hashSecret()` is one function for staff and members, so
 * the hash is portable and cannot drift out of step with lane A's seed.
 */
const PIN_MEMBER = 'QA-CT-0001';
const PIN_MEMBER_PHONE = '+96599777401';
const PIN_MEMBER_PASSWORD = 'noura-dev-password';

function seedPinMember(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${PIN_MEMBER}', '${SALON_B}', 'Contract Pin', '${PIN_MEMBER_PHONE}',
           NULL, false, s.password_hash, 0, 0, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      password_hash         = EXCLUDED.password_hash,
      balance_fils          = 0,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
}

/**
 * NINE DAYS OUT, AND THE NUMBER IS LOAD-BEARING.
 *
 * Not today: on today's date every slot is already past and therefore carries a
 * `reason`, which is the exact condition that hid drift (4) from the fix that
 * caused it. Not tomorrow either — `AR-001`'s week is closed on Friday, and a
 * fixed one-day offset lands on it once every seven runs and turns this file red
 * for a reason that has nothing to do with the contract. Nine days forward from
 * a Monday is still a Wednesday; the loop below moves off a closed day if the
 * grid comes back empty, and the assertion is on the grid, never on the date.
 */
function isoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** Responses captured once in `beforeAll`, so a POST is not replayed per spec. */
const captured = new Map<string, { status: number; body: any; raw: string }>();

let bookingDate = '';
let quietDate = '';
let bookingId = '';
let topUpId = '';

// ---------------------------------------------------------------- the probes --

interface Probe {
  /** The route AS REGISTERED, for the census. `GET /salons/:id/services`. */
  route: string;
  /** The concrete call this run made. Appears in the spec title. */
  label: string;
  /**
   * The key `beforeAll` filed the response under. Defaults to `label`; set it
   * where two probes read two different entities out of ONE response, so the
   * write is performed once and not once per assertion.
   */
  source?: string;
  schemaName: string;
  schema: ParsesLikeZod;
  /** Dot path into the response body, when the schema describes part of it. */
  select?: string;
  /**
   * Arrays that MUST carry a row, or the probe proved nothing. An item schema
   * exercised against zero items is a spec that cannot fail.
   */
  requireNonEmpty?: string[];
  /**
   * Keys the wire carries on purpose that NO schema in `packages/types` models.
   * Every entry needs a reason. Checked in both directions: an unannotated
   * stripped key fails, and an annotation for a key that is no longer served
   * fails too, so this cannot silently become a place to bury drift.
   */
  wireOnly?: Record<string, string>;
  /** A live drift in the schema. Reported, not fixed — not lane D's column. */
  knownStripped?: string;
  knownParseFailure?: string;
}

function at(body: unknown, path?: string): unknown {
  if (!path) return body;
  return path.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), body);
}

/**
 * DRIFT (7), CLOSED — AND IT WAS FIXED AT THE CAUSE RATHER THAN THE SYMPTOM.
 *
 * Recorded here because the shape of the fix is the lesson, and because this file
 * argued for it.
 *
 * `TransactionSchema` declares `voidedAt` and `reversedByTransactionId` as
 * `.nullable()` without `.optional()`, which makes them REQUIRED on every
 * transaction. That is the third outage this project has had from one sentence —
 * `.nullable()` does not imply `.optional()` — after the Book grid's `reason` (4)
 * and `SubtractedBlockSchema.from/to` (6).
 *
 * But the schema modifier was only the symptom. `serialiseTransactionForCustomer`
 * was taught to emit both keys and TWO ROUTES STILL FAILED, because
 * `charge.ts` and `booking.ts` each hand-assembled the transaction literal instead
 * of calling that serialiser — one payload built in three places, so a fix applied
 * to one builder reached neither of the others. The same defect had already put
 * `heldDepositFils` at `0` on the scan path while the charge path read it for real,
 * and `services/counter.ts` exists because of it.
 *
 * There were two candidate fixes and they were not equivalent: `.nullish()` would
 * have made the contract match the wire and left three builders standing, while
 * routing both POSTs through the serialiser removes the duplication that caused it.
 * Lane A took the second. All four probes are plain `it()` now, so the day anything
 * stops going through that serialiser, this file says so.
 */

function probes(): Probe[] {
  return [
    // ------------------------------------------------------------- the salon --
    {
      route: 'GET /salons/:id',
      label: `GET /salons/${SALON_A}`,
      schemaName: 'SalonSchema',
      schema: SalonSchema,
      requireNonEmpty: ['branches', 'social', 'tiers'],
    },
    {
      route: 'GET /salons/:id/metrics',
      label: `GET /salons/${SALON_A}/metrics`,
      schemaName: 'SalonMetricsSchema',
      schema: SalonMetricsSchema,
    },
    {
      route: 'GET /salons/:id/services',
      label: `GET /salons/${SALON_A}/services`,
      schemaName: 'paginated(ServiceSchema)',
      schema: paginated(ServiceSchema),
      requireNonEmpty: ['items'],
    },
    {
      route: 'GET /salons/:id/artists',
      label: `GET /salons/${SALON_A}/artists`,
      schemaName: 'paginated(ArtistSchema)',
      schema: paginated(ArtistSchema),
      requireNonEmpty: ['items'],
    },
    {
      /**
       * WITNESSED AT LAST. This route sat outside the census as `PRODUCTS_ROUTE`
       * because `ProductSchema` had no live sample — the seed created no products, so
       * `items` was always `[]` and a parse of an empty array asserts nothing about the
       * element shape. A placeholder spec asserted the emptiness and carried the
       * instruction to turn this on, so the gap closed itself the hour lane A seeded
       * the shop: that spec went red naming the three products, and this is the probe
       * it asked for. `requireNonEmpty` is what makes it real.
       */
      route: 'GET /salons/:id/products',
      label: `GET /salons/${SALON_A}/products`,
      schemaName: 'paginated(ProductSchema)',
      schema: paginated(ProductSchema),
      requireNonEmpty: ['items'],
    },
    {
      // The route whose arrival tripped the tenancy ledger this morning, and the
      // one that had no schema at all until an hour after it shipped.
      route: 'GET /salons/:id/artists/bookable',
      label: `GET /salons/${SALON_A}/artists/bookable`,
      schemaName: 'paginated(BookableArtistSchema)',
      schema: paginated(BookableArtistSchema),
      requireNonEmpty: ['items'],
    },
    {
      /**
       * The merchant's own view of the ceiling its campaigns are subject to. Landed
       * with lane A's campaign work and caught by the unclassified check.
       *
       * `PlatformMessagingPolicySchema` is the same shape the platform serves, which is
       * the point: a merchant reads the caps and quiet hours it is bound by and cannot
       * raise them (the write verbs are behind `requirePlatform`). Probed with the
       * salon-scoped credential, because that is who this door is for.
       */
      route: 'GET /v1/salons/:id/messaging-policy',
      label: `GET /v1/salons/${SALON_A}/messaging-policy`,
      schemaName: 'PlatformMessagingPolicySchema',
      schema: PlatformMessagingPolicySchema,
    },
    {
      /**
       * The salon's own campaigns. WITNESSED BY A CAMPAIGN THIS FILE CREATES, because
       * the seed makes none and an empty `items` would witness the envelope while
       * saying nothing about `CampaignSchema` — the trap the products route sat in for
       * weeks.
       *
       * Creating one is safe and is itself a check on non-negotiable #8:
       * `POST /v1/salons/{id}/campaigns` can only ever produce `pending`. A merchant
       * cannot send a customer message, so there is no way for this fixture to deliver
       * anything.
       */
      route: 'GET /v1/salons/:id/campaigns',
      label: `GET /v1/salons/${SALON_A}/campaigns`,
      schemaName: 'paginated(CampaignSchema)',
      schema: paginated(CampaignSchema),
      requireNonEmpty: ['items'],
      /**
       * FIXED ON 2026-08-19, AND NOW A PLAIN SPEC. This probe carried
       * `knownParseFailure`, and the harness is what reported the fix rather than a
       * human noticing: `knownBug()` FAILS when the contract-correct assertion starts
       * passing, so the run at 08:54 Kuwait came back "This bug appears to be FIXED" on
       * both halves. That is the whole reason the wrapper fails forwards.
       *
       * WHAT IT WAS. `serialiseCampaign` omitted both keys. `CampaignSchema` declares
       * them `.nullable()` but NOT `.optional()` — deliberately, per its own docstring:
       * "`null` on every campaign that was never held, which is most of them." Zod
       * fails the whole object on a missing key, so a client built on `CampaignSchema`
       * could not parse ANY campaign, the ordinary `pending` one included. Lane A now
       * serves both — `routes/campaigns.ts:112-113`, `heldAt` as an ISO string.
       *
       * WHY THIS BECOMES A PERMANENT SPEC INSTEAD OF A CLOSED TICKET. These are the two
       * fields non-negotiable #8 turns on. A held campaign keeps `status: 'approved'` —
       * `CampaignSchema` declares four statuses and a fifth on the wire is a value every
       * client's `.parse()` rejects — so `heldReason`/`heldAt` are the ONLY thing that
       * distinguishes a campaign the platform refused to send from one on its way out.
       * If these keys stop arriving, a held campaign renders to the merchant as approved
       * and the silent drop #8 forbids is back, with no other field able to report it.
       * Two fields and not a boolean for the reason the schema gives: "held until 09:00"
       * and "held — this customer has had two messages this week" are different things
       * for a merchant to do next.
       *
       * This probe pins the SHAPE, on the ordinary never-held campaign every merchant
       * sees first, which is the half that broke. The VALUES on a genuinely held
       * campaign are pinned against a campaign that really gets held, in
       * `campaigns.test.ts`.
       */
    },
    /**
     * THE APPROVAL QUEUE, across every salon. Reachable since `signInPlatform` landed.
     *
     * `requireNonEmpty: ['items']` is safe and load-bearing here: this file submits a
     * campaign at salon A (see the salon-scoped probe above), it stays `pending` because a
     * merchant cannot send, and the platform queue with no status filter lists every
     * status — so the row this file created is in it. An empty `items` would witness the
     * envelope and say nothing about `CampaignSchema`, which is the trap the products
     * route sat in for weeks.
     *
     * IT IS THE SAME SCHEMA AS THE SALON-SIDE LIST AND A DIFFERENT SERIALISER PATH: this
     * one joins `salon` for the name and orders differently. `heldReason`/`heldAt` were
     * missing from `serialiseCampaign` until today, and one probe would have caught that
     * on one door only.
     */
    {
      route: 'GET /v1/platform/campaigns',
      label: 'GET /v1/platform/campaigns',
      schemaName: 'paginated(CampaignSchema)',
      schema: paginated(CampaignSchema),
      requireNonEmpty: ['items'],
    },
    /**
     * The caps and quiet hours as the platform sees them. The salon-scoped read of the
     * same shape is probed above; this is the platform door, and the two must not drift —
     * `api-contract.md` says a merchant can never read or RAISE these values, so the
     * merchant view being a faithful subset of this one is the whole basis of the
     * dashboard being able to state them at all.
     */
    {
      route: 'GET /v1/platform/messaging-policy',
      label: 'GET /v1/platform/messaging-policy',
      schemaName: 'PlatformMessagingPolicySchema',
      schema: PlatformMessagingPolicySchema,
    },
    {
      route: 'GET /v1/salons/:id/promotions',
      label: `GET /v1/salons/${SALON_A}/promotions`,
      schemaName: 'PromotionSetSchema',
      schema: PromotionSetSchema,
      requireNonEmpty: ['happy'],
    },

    // ------------------------------------------------------------ the member --
    {
      route: 'GET /members/me',
      label: 'GET /members/me',
      schemaName: 'MemberSchema',
      schema: MemberSchema,
    },
    {
      route: 'GET /members/me/transactions',
      label: 'GET /members/me/transactions',
      schemaName: 'paginated(TransactionSchema)',
      schema: paginated(TransactionSchema),
      requireNonEmpty: ['items'],
      // PROMOTED: `serialiseTransactionForCustomer` emits both void keys now — as
      // `null` when there is no reversal, which is the shape the schema asks for.
      // The two POST responses below still do not, because they do not use this
      // serialiser. See DRIFT (7).
    },
    {
      route: 'GET /members/me/wallet-token',
      label: 'GET /members/me/wallet-token',
      schemaName: 'WalletTokenSchema',
      schema: WalletTokenSchema,
      // PROMOTED: `uri` is declared now, so the server's QR string is the one every
      // client reads instead of re-deriving its own.
    },

    // ----------------------------------------------------------- the booking --
    {
      route: 'GET /bookings',
      label: 'GET /bookings',
      schemaName: 'paginated(BookingSchema)',
      schema: paginated(BookingSchema),
      requireNonEmpty: ['items'],
    },
    {
      route: 'GET /bookings/:id',
      label: 'GET /bookings/{id}',
      schemaName: 'BookingSchema',
      schema: BookingSchema,
    },
    /**
     * AVAILABILITY IS PROBED TWICE, ON PURPOSE, AND THE SECOND ONE IS THE POINT.
     *
     * An unbooked day returns `subtracted: []`, and an empty array satisfies any
     * item schema whatsoever. That is not a hypothetical: the probe below found
     * `SubtractedBlockSchema` — added an hour ago as part of the fix for drifts
     * (3) and (4) — declaring `from`/`to` as ISO datetimes against an API that
     * sends salon-local wall clock, `"10:00"`. It parses perfectly on an empty
     * day and THROWS the moment anybody books, which is every day the Book grid
     * matters on. Exactly the shape of (4), one layer down, and written with the
     * best of intentions against a sample that could not contradict it.
     *
     * So: the unbooked day carries the stripping comparison for the envelope and
     * the slot grid, and the booked day carries the item schema that only exists
     * once a row does.
     */
    {
      route: 'GET /artists/:id/availability',
      label: `GET /artists/${A_QUIET_ARTIST}/availability?date={future, unbooked}`,
      schemaName: 'AvailabilityDaySchema',
      schema: AvailabilityDaySchema,
      requireNonEmpty: ['slots'],
    },
    {
      route: 'GET /artists/:id/availability',
      label: `GET /artists/${A_ARTIST}/availability?date={future, booked}`,
      schemaName: 'AvailabilityDaySchema',
      schema: AvailabilityDaySchema,
      // Non-empty because this run booked into this exact day. Without that the
      // list stays `[]` and SubtractedBlockSchema is never exercised at all —
      // which is precisely how it shipped wrong.
      requireNonEmpty: ['slots', 'subtracted'],
      /**
       * PROMOTED. `SubtractedBlockSchema` typed `from`/`to` as ISO instants against
       * an API sending the salon-local wall clock `"10:00"`, so the Book grid threw
       * on any day that had a booking and passed on an empty one. It is wall clock
       * on both sides now, and this probe still books into the day it reads, so the
       * item schema is exercised against a row that exists rather than against `[]`.
       */
    },
    {
      route: 'GET /artists/me',
      label: 'GET /artists/me',
      schemaName: 'ArtistSchema',
      schema: ArtistSchema,
    },

    // ------------------------------------------------------------- the staff --
    {
      route: 'GET /staff',
      label: 'GET /staff',
      schemaName: 'paginated(StaffUserSchema)',
      schema: paginated(StaffUserSchema),
      requireNonEmpty: ['items'],
      // PROMOTED: `passwordSet`, `active` and `deactivatedAt` are declared now, so
      // the dashboard can tell a live account from a retired one through the
      // contract. `passwordSet` is also what permissions.test.ts had to stop
      // reading as a leaked credential — it is the flag that exists so no password
      // has to travel.
    },
    {
      route: 'GET /staff/me',
      label: 'GET /staff/me',
      schemaName: 'StaffUserSchema',
      schema: StaffUserSchema,
      // PROMOTED with GET /staff — same three keys.
    },
    {
      route: 'GET /charges',
      label: 'GET /charges',
      schemaName: 'paginated(TransactionSchema)',
      schema: paginated(TransactionSchema),
      requireNonEmpty: ['items'],
      /**
       * PROMOTED, AND IT WAS THE FIRST OF FOUR.
       *
       * `voidedAt` and `reversedByTransactionId` are the void state of a charge: the
       * scanner's Today screen could not tell a reversed charge from a live one
       * through the contract, on the one surface where a 15-minute reversal window is
       * the entire feature. Adding them to TransactionSchema fixed this route and
       * broke the three that did not serve them — see DRIFT (7) above, which is now
       * closed at the cause. All four transaction probes parse.
       */
    },

    // ---------------------------------------------------------- the platform --
    {
      route: 'GET /v1/platform/policies',
      label: 'GET /v1/platform/policies',
      schemaName: 'LegalDocumentSetSchema',
      schema: LegalDocumentSetSchema,
      requireNonEmpty: ['published.docs'],
      /**
       * PROMOTED. `draft` was REQUIRED against an API serving `{published}` alone,
       * so the customer app's whole legal set failed to parse and non-negotiable
       * #10 could not be satisfied through the contract at all. `draft` is an
       * owner-console concern and is optional now.
       */
    },
    {
      route: 'GET /v1/platform/support',
      label: 'GET /v1/platform/support',
      schemaName: 'SupportConfigSchema',
      schema: SupportConfigSchema,
      requireNonEmpty: ['topics'],
    },

    // -------------------------------------------- writes that return entities --
    {
      route: 'POST /bookings',
      label: 'POST /bookings → body.booking',
      source: 'POST /bookings',
      schemaName: 'BookingSchema',
      schema: BookingSchema,
      select: 'booking',
    },
    {
      route: 'POST /bookings',
      label: 'POST /bookings → body.transaction',
      source: 'POST /bookings',
      schemaName: 'TransactionSchema',
      schema: TransactionSchema,
      select: 'transaction',
    },
    {
      route: 'POST /topups',
      label: 'POST /topups',
      schemaName: 'TopUpIntentPublicSchema',
      schema: TopUpIntentPublicSchema,
    },
    {
      route: 'GET /topups/:id',
      label: 'GET /topups/{id}',
      schemaName: 'TopUpIntentPublicSchema',
      schema: TopUpIntentPublicSchema,
    },
    {
      route: 'POST /charges',
      label: 'POST /charges → body.transaction',
      source: 'POST /charges',
      schemaName: 'TransactionSchema',
      schema: TransactionSchema,
      select: 'transaction',
    },
    {
      route: 'POST /v1/support/tickets',
      label: 'POST /v1/support/tickets',
      schemaName: 'SupportTicketSchema',
      schema: SupportTicketSchema,
      // PROMOTED: `transactionId` is declared now, so a wallet dispute still names
      // the charge it is about by the time a client reads it.
    },
  ];
}

/**
 * Served shapes with no schema in `packages/types`, each with the reason.
 *
 * NOT a skip list. The census below requires every GET route to appear either in
 * `probes()` or here, so nothing can drop out of sight — and writing a route here
 * is a claim someone can disagree with, which is the point. Three of these are
 * genuinely NOT the entity: a scanner's member search is deliberately narrower
 * than `Member` (no balance), and the two booking lists are `Booking` plus joined
 * display columns. Two are genuinely unmodelled and should have a schema.
 */
const UNMODELLED: Record<string, string> = {
  /**
   * THE TWO CONSOLE ROUTES THAT MOVED HERE FROM `NEEDS_PLATFORM_CREDENTIAL` on 2026-08-19.
   * They are reachable now — `signInPlatform` exists — so "no credential" stopped being
   * true of them while "no schema" stayed true. The § note on that map's guard spec has
   * the full accounting.
   */
  'GET /v1/platform/admins':
    'the owner console\'s admin list, behind requirePlatform(admins). REACHABLE since ' +
    'signInPlatform landed; what it lacks is a schema — `PlatformAdmin` is unmodelled in ' +
    'packages/types, and the nine section booleans plus role/owner/active have no declared ' +
    'shape. Worth a PlatformAdminSchema when the console\'s Admins editor is wired; that is ' +
    'a trunk change to packages/types, not lane D\'s.',
  'GET /v1/platform/policies/draft':
    'the UNPUBLISHED legal set, behind requirePlatform(policies). REACHABLE since ' +
    'signInPlatform landed. Non-negotiable #10 is about the PUBLISHED set, which ' +
    'GET /v1/platform/policies serves and this file probes against LegalSetSchema; a draft ' +
    'is a console-only shape with no client and no schema. It should get one when publish ' +
    'gets a client, because a draft that cannot be parsed is a draft nobody can review.',
  'GET /members':
    'the scanner\'s member search — {id, salonId, name, phoneLast4, tier}. DELIBERATELY ' +
    'narrower than MemberSchema: a scanner has no business holding a balance, and ' +
    'phoneLast4 rather than phone is the disclosure decision. Parsing it as Member ' +
    'would fail, correctly. It has no schema of its own; a MemberSearchRow would be ' +
    'worth having.',
  'GET /salons/:id/bookings':
    'the merchant Appointments row — BookingSchema plus `branchAssumed`, `memberName`, ' +
    '`memberPhone`, `memberTier`, `artistName`, `serviceName`. A dashboard typing this ' +
    'as `Booking` loses the customer\'s name and phone, which is most of the screen. ' +
    'Needs a MerchantBookingRow schema.',
  'GET /artists/me/bookings':
    'the artist\'s own day — BookingSchema plus `memberName`, `memberPhone`, ' +
    '`memberTier`, `serviceName`. Same family as the merchant row above.',
  'GET /salons/:id/loyalty':
    'the Loyalty screen\'s read model — the salon\'s tier ladder plus a computed ' +
    '`preview` of what a 10.000 KD top-up credits at each tier. A view, not an entity.',
  'GET /salons/:id/audit':
    'the audit log page — rows plus `total`, `appendOnly` and `retentionYears`. A view.',
  'GET /salons/:id/activity':
    'the merchant activity feed, a union of transaction and booking streams. A view.',
  'GET /salons/:id/branches/:bid/closure-preview':
    'what closing a branch WOULD do — the branch row plus `closable`, `blockedReason`, ' +
    '`openBranchCount`, the two staff name lists, and the two held-deposit counts. A view over ' +
    'a hypothetical, so it is not an entity and has no schema; it is also NOT the place to add ' +
    'one, because the property that matters is not its shape but its IDENTITY with the close\'s ' +
    'own report — both are built by `branchClosureImpact` and scanner-style deep equality is a ' +
    'stronger guard than two schemas would be. Asserted in configuration.test.ts.',
  'GET /members/:id':
    'the scanner\'s member RESOLVE, and it serves the `POST /scans` ENVELOPE rather than a bare ' +
    'Member — member plus the counter state the charge screen needs. Unmodelled because that ' +
    'envelope has no schema either, on either of its two doors, which is the gap worth naming: ' +
    'two hand-assembled copies of one screen\'s payload is exactly how `heldDepositFils` came to ' +
    'be hardcoded 0 on the scan path while the charge read it for real. `services/counter.ts` is ' +
    'now the single builder, and scanner.test.ts asserts the two envelopes are DEEP-EQUAL, which ' +
    'guards the shared builder better than a schema on either path would. A ScanEnvelope schema ' +
    'is worth having.',
  'GET /members/me/deletion':
    'the deletion state — {requestedAt, erasureDueAt, status, graceDays, erasureScheduled}. Same ' +
    'shape as its POST and DELETE, and unmodelled for the same reason as the notifications set ' +
    'below: it postdates packages/types. WIRE-PINNED at the bottom of this file against the same ' +
    'DELETION_WIRE constant as the two writes, with a spec comparing all three live responses to ' +
    'each other — the wallet renders the pending banner from this read and the confirmation from ' +
    'the write, so the three cannot be allowed to drift apart. Worth a schema.',
  'GET /members/me/notifications':
    'the notification preference set and its consent record. Genuinely unmodelled and ' +
    'it carries a consent decision (`offersConsent.policyVersion`) — the kind of field ' +
    'non-negotiable #10 is about. Worth a schema. UNTIL IT HAS ONE it is WIRE-PINNED at ' +
    'the bottom of this file, in both directions, along with its PATCH and the two ' +
    'deletion routes — the wallet reads all four today, so "unmodelled" was the whole ' +
    'of the guard on a shape a client is already built against.',
  'GET /members/me/policy-acceptance':
    'the #10 re-prompt decision — {published:{version,effectiveFrom,publishedAt}, ' +
    'accepted:{version,at,source}, stampedVersion, upToDate}. NOT an entity: it is a computed ' +
    'answer to "should the terms go in front of her again", derived from the published set, her ' +
    'acceptance EVENTS and the cached member column, and `upToDate` exists nowhere but here. ' +
    'Same family as the notifications set above and it carries the same weight — a consent ' +
    'decision under non-negotiable #10, which is the one non-negotiable about a shape rather ' +
    'than a behaviour. WIRE-PINNED at the bottom of this file, in both directions, against the ' +
    'same POLICY_ACCEPTANCE_WIRE constant as its POST, with a spec asserting the two are ' +
    'identical: the wallet decides whether to show the re-prompt from the read and renders the ' +
    'confirmation from the write, so a key on one and not the other is a screen that contradicts ' +
    'the tap that produced it. WORTH A SCHEMA — see the note to trunk in the lane report; ' +
    'packages/types is trunk-owned, so this lane pins rather than adds one.',
  'GET /_gateway/:ref':
    'the sandbox PSP\'s hosted page. Serves HTML to a browser, not JSON to a client, ' +
    'and exists only under the test driver.',
};

/**
 * `GET /salons/:id/products` WAS HERE, exempted from the census because
 * `ProductSchema` had no live sample to witness. Lane A has seeded the shop, the
 * placeholder spec went red as designed, and the route is now a real probe in
 * `probes()` with `requireNonEmpty: ['items']`. The exemption is gone rather than
 * left in place unused: a stale exemption is a hole nobody remembers opening.
 */

/**
 * ROUTES LANE A HAS COMMITTED BUT WHICH HAVE NOT MERGED INTO THIS BRANCH YET.
 *
 * NOT AN EXEMPTION, and the difference is the spec at the bottom of the census:
 * an entry here is green ONLY while the route is absent from disk. The hour it
 * lands, that spec goes RED holding the instruction below. So a route cannot slip
 * through in either state — unlisted and served fails the unclassified check,
 * listed and served fails the arrival check.
 *
 * WHY THIS EXISTS AT ALL. Lane D is told to test integrated code, so its branch
 * necessarily trails lane A's by a merge. Trunk relayed `GET /members/me/deletion`
 * (feat/api 540b3f1) before it reached this checkout, and the census cannot be
 * taught about a route in advance: `UNMODELLED` is checked in both directions, so
 * an entry for a route that is not served yet fails the ghost spec — correctly,
 * because that check is what stops UNMODELLED becoming a graveyard. The choice was
 * to weaken the ghost check for everything or to write the pending arrival down
 * where it is visible. This is the second.
 */
/**
 * SERVED, SCHEMA'D, AND UNREACHABLE FROM THIS FILE — a third state, and it needed its
 * own map rather than a line in `UNMODELLED`.
 *
 * `UNMODELLED` means "there is no schema in packages/types and here is why". These
 * routes are not that: `GET /v1/platform/campaigns` and
 * `GET /v1/platform/messaging-policy` serve shapes this file already probes from the
 * salon side, so filing them as unmodelled would be false in the one direction the
 * census exists to prevent — a route recorded as having no schema when it has one is a
 * drift nobody will look for.
 *
 * What stops them being probed is a CREDENTIAL. Every one is behind
 * `requirePlatform`, and `support/tenancy-harness.ts` can mint a member, a staff web
 * session and a scanner PIN session — there is no platform sign-in helper, because
 * until lane A landed `platformAdmins.ts` there was no platform principal at all.
 *
 * SELF-EXPIRING, exactly like `AWAITING_MERGE`. The spec below asserts the harness
 * still cannot mint a platform credential; the hour it can, this map goes red and each
 * of these becomes an ordinary probe. So "unreachable" cannot quietly become
 * "untested".
 */
const NEEDS_PLATFORM_CREDENTIAL: Record<string, string> = {
  /**
   * EMPTY SINCE 2026-08-19, AND EMPTIED BY ITS OWN GUARD SPEC. All four entries are
   * accounted for in the § note on that spec below: two became ordinary probes the moment
   * `signInPlatform` existed, and two moved to `UNMODELLED` because what they actually lack
   * is a schema, not a credential.
   *
   * Kept, inverted, for the next capability this file is missing. The guard spec now
   * asserts the map is EMPTY and that the harness still has the sign-in — so neither a
   * silently re-added excuse nor a silently removed capability goes unnoticed.
   */
};

const AWAITING_MERGE: Record<string, string> = {
  /**
   * EMPTY, AND IT EARNED ITS KEEP ON THE FIRST TRY.
   *
   * `GET /members/me/deletion` was listed here before it existed. It landed in the
   * rebase, the arrival spec below went red printing its own instructions, and the
   * three things it asked for were done: it is pinned against DELETION_WIRE, it is
   * in the scope `calls` array in account.test.ts, and the entry is gone. That is
   * the whole intended life cycle of an entry in this map.
   *
   * Leave the mechanism in place for the next one. An empty map costs two passing
   * specs and is the difference between a route arriving loudly and arriving in
   * whichever spec happens to break first.
   */
};

// ------------------------------------------------------------------- the run --

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  scanner = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);
  member = await signInMember(SALON_A, QA_MEMBER_PHONE);
  platform = await signInPlatform(PLATFORM_OWNER_HANDLE);

  const hessa = await attemptScannerSignIn({
    salonId: SALON_A,
    handle: A_ARTIST_STAFF_HANDLE,
    deviceId: A_SCANNER_DEVICE,
    pin: A_ARTIST_STAFF_PIN,
  });
  if (hessa.status !== 200 || !hessa.body?.accessToken) {
    throw new Error(`Hessa could not sign in on the scanner: ${hessa.status} ${hessa.raw}`);
  }
  artistScanner = hessa.body.accessToken;

  // ---- a settled top-up, through the real gateway path ----------------------
  const topup = await treq<any>('POST', '/topups', {
    token: member,
    idempotencyKey: key('topup'),
    body: { amountFils: 20_000, method: 'knet' },
  });
  if (topup.status !== 200) throw new Error(`POST /topups: ${topup.status} ${topup.raw}`);
  captured.set('POST /topups', topup);
  topUpId = topup.body.id;

  const ref = /\/_gateway\/([^/?#]+)/.exec(topup.body.redirectUrl ?? '')?.[1];
  if (!ref) throw new Error(`No sandbox gateway ref in ${topup.body.redirectUrl}`);
  const settled = await treq('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  if (settled.status !== 200) throw new Error(`Gateway settle: ${settled.status} ${settled.raw}`);

  // ---- a real booking, on a FUTURE date --------------------------------------
  // Walk forward until the artist's week is open. The assertion is on the grid,
  // never on the calendar — see `isoDate`.
  let slot: string | undefined;
  for (let d = 9; d < 16 && !slot; d++) {
    bookingDate = isoDate(d);
    const day = await treq<any>('GET', `/artists/${A_ARTIST}/availability?date=${bookingDate}`, {
      token: member,
    });
    if (day.status !== 200) throw new Error(`availability ${bookingDate}: ${day.status} ${day.raw}`);
    slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
  }
  if (!slot) {
    throw new Error(
      `${A_ARTIST} has no bookable slot in the next fortnight, so this file cannot build a ` +
        'sample. That is a defect in availability, not in this suite.',
    );
  }

  // The unbooked control day, found the same way and never written to. A fixed
  // offset would land on the artist's closed Friday once every seven runs.
  for (let d = 9; d < 16 && !quietDate; d++) {
    const candidate = isoDate(d);
    const day = await treq<any>('GET', `/artists/${A_QUIET_ARTIST}/availability?date=${candidate}`, {
      token: member,
    });
    if (day.status === 200 && (day.body?.slots?.length ?? 0) > 0) quietDate = candidate;
  }
  if (!quietDate) {
    throw new Error(
      `${A_QUIET_ARTIST} has no open day in the next fortnight, so the unbooked availability ` +
        'control cannot be built.',
    );
  }

  const booked = await treq<any>('POST', '/bookings', {
    token: member,
    idempotencyKey: key('booking'),
    body: { artistId: A_ARTIST, serviceId: A_SERVICE, startsAt: slot },
  });
  if (booked.status !== 201) throw new Error(`POST /bookings: ${booked.status} ${booked.raw}`);
  captured.set('POST /bookings', booked);
  bookingId = booked.body.booking.id;

  // ---- a real charge on the scanner ------------------------------------------
  const walletToken = await mintWalletTokenFor(member, QA_MEMBER);
  const charged = await treq<any>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key('charge'),
    body: { memberId: QA_MEMBER, token: walletToken, serviceIds: [A_SERVICE] },
  });
  if (charged.status !== 200) throw new Error(`POST /charges: ${charged.status} ${charged.raw}`);
  captured.set('POST /charges', charged);

  // ---- the four shapes with no schema, captured in the order that makes them --
  //
  // GET first, so the pin sees the never-asked consent record — `granted: false`
  // with three nulls beside it — which is the shape that distinguishes "she said
  // no" from "she has never been asked", and the shape a `.nullable()` that
  // forgot `.optional()` would reject. Then the PATCH, which must serve the
  // IDENTICAL key set: the wallet binds one screen to both, so a response that
  // grew on one and not the other is drift the screen cannot see.
  seedPinMember();
  pinMember = await signInMember(SALON_B, PIN_MEMBER_PHONE);

  const notifications = await treq<any>('GET', '/members/me/notifications', { token: pinMember });
  if (notifications.status !== 200) {
    throw new Error(`GET /members/me/notifications: ${notifications.status} ${notifications.raw}`);
  }
  captured.set('GET /members/me/notifications', notifications);

  const patched = await treq<any>('PATCH', '/members/me/notifications', {
    token: pinMember,
    body: { offers: true },
  });
  if (patched.status !== 200) {
    throw new Error(`PATCH /members/me/notifications: ${patched.status} ${patched.raw}`);
  }
  captured.set('PATCH /members/me/notifications', patched);

  // She is seeded at zero, so the 200 is reachable. A 409 here means the seed
  // gave her credit, not that the endpoint is wrong — say which.
  const requested = await treq<any>('POST', '/members/me/deletion', {
    token: pinMember,
    body: { password: PIN_MEMBER_PASSWORD },
  });
  if (requested.status !== 200) {
    throw new Error(
      `POST /members/me/deletion: ${requested.status} ${requested.raw}\n` +
        `A 409 balance_outstanding means ${PIN_MEMBER} was seeded with credit; this file needs ` +
        'her at zero to sample the accepted shape at all.',
    );
  }
  captured.set('POST /members/me/deletion', requested);

  const cancelled = await treq<any>('DELETE', '/members/me/deletion', { token: pinMember });
  if (cancelled.status !== 200) {
    throw new Error(`DELETE /members/me/deletion: ${cancelled.status} ${cancelled.raw}`);
  }
  captured.set('DELETE /members/me/deletion', cancelled);

  // The READ, which arrived in lane A's 540b3f1 so the wallet could render the
  // pending banner without POSTing to find out what the state was. Captured AFTER
  // the cancel, so the sample is the `none` state — which is the one a client sees
  // on almost every open, and the one whose two null instants a schema that forgot
  // `.optional()` would reject. Drift (7) is that mistake, three doors down.
  const readBack = await treq<any>('GET', '/members/me/deletion', { token: pinMember });
  if (readBack.status !== 200) {
    throw new Error(`GET /members/me/deletion: ${readBack.status} ${readBack.raw}`);
  }
  captured.set('GET /members/me/deletion', readBack);

  // ---- a campaign, so paginated(CampaignSchema) has a live sample ---------------
  /**
   * The seed creates no campaigns, so the salon's list would be `{items: []}` and the
   * probe would witness the envelope and nothing inside it — the exact trap
   * `GET /salons/{id}/products` sat in until a product was seeded.
   *
   * NON-NEGOTIABLE #8 IS WHY THIS IS SAFE TO CREATE AND WORTH CREATING. "A merchant
   * cannot send a customer message. POST /campaigns only creates `pending`." So this
   * write cannot deliver anything to anybody, and the status it comes back with is
   * itself the check: anything other than `pending` here is #8 broken, which is why
   * that is asserted rather than assumed.
   */
  const campaign = await treq<any>('POST', `/v1/salons/${SALON_A}/campaigns`, {
    token: dashboard,
    idempotencyKey: key('campaign'),
    body: {
      title: 'Eid offer',
      body: 'Twenty percent off colour this week.',
      channel: 'push',
      audience: 'all',
      when: 'now',
      reward: 'none',
    },
  });
  if (campaign.status !== 201 && campaign.status !== 200) {
    throw new Error(
      `POST /v1/salons/${SALON_A}/campaigns: ${campaign.status} ${campaign.raw}\n` +
        'This file needs one campaign so CampaignSchema has something to be witnessed against.',
    );
  }
  const createdStatus = campaign.body?.campaign?.status ?? campaign.body?.status;
  if (createdStatus !== 'pending') {
    throw new Error(
      `POST /v1/salons/{id}/campaigns created a campaign with status "${createdStatus}", not ` +
        '"pending". NON-NEGOTIABLE #8: a merchant cannot send a customer message — delivery ' +
        'happens on the platform decision endpoint, and caps and quiet hours are enforced again ' +
        `at send time.\n--- served ---\n${campaign.raw}`,
    );
  }

  // ---- the #10 re-prompt state, both doors, with `accepted` POPULATED -----------
  /**
   * ORDER MATTERS AND IT IS THE POINT. A member who has never accepted anything
   * serves `accepted: null`, which `wireShape` flattens to one leaf — so a pin
   * captured in that state would declare nothing about the three keys inside it and
   * would keep passing if they disappeared.
   *
   * So: read to learn which version is published, POST that version to create the
   * evidence, then read again. The POST is safe to repeat — routes/members.ts treats
   * an already-accepted version as a success with nothing to write, because
   * `member_consent_acceptance_once_per_version` would otherwise turn a careful
   * customer's second tap into a 500.
   *
   * The version is read from the API rather than written here. Hardcoding `3` would
   * make this capture fail the day the seed publishes a fourth set, and the pin is
   * about the SHAPE — pinning the number as an input would be pinning the fixture.
   */
  const policyProbe = await treq<any>('GET', '/members/me/policy-acceptance', {
    token: pinMember,
  });
  if (policyProbe.status !== 200) {
    throw new Error(
      `GET /members/me/policy-acceptance: ${policyProbe.status} ${policyProbe.raw}`,
    );
  }
  const publishedVersion = policyProbe.body?.published?.version;
  if (typeof publishedVersion !== 'number') {
    throw new Error(
      'GET /members/me/policy-acceptance served no published.version, so this file cannot ' +
        'accept a version in order to sample the accepted shape.\n' +
        `--- served ---\n${policyProbe.raw}`,
    );
  }

  const accepted = await treq<any>('POST', '/members/me/policy-acceptance', {
    token: pinMember,
    body: { policyVersion: publishedVersion },
  });
  if (accepted.status !== 200) {
    throw new Error(
      `POST /members/me/policy-acceptance: ${accepted.status} ${accepted.raw}
` +
        `A policy_version_stale means the published set moved between the read above and this ` +
        'write, which is a real race and not a fixture problem — re-run.',
    );
  }
  captured.set('POST /members/me/policy-acceptance', accepted);

  const policyRead = await treq<any>('GET', '/members/me/policy-acceptance', {
    token: pinMember,
  });
  if (policyRead.status !== 200) {
    throw new Error(`GET /members/me/policy-acceptance: ${policyRead.status} ${policyRead.raw}`);
  }
  if (policyRead.body?.accepted == null) {
    throw new Error(
      'GET /members/me/policy-acceptance still serves a null `accepted` after the POST above ' +
        'succeeded, so the pin would declare nothing about its contents. Either the write did ' +
        'not record the event or the read does not see it — both are defects worth the loud ' +
        `failure.\n--- served ---\n${policyRead.raw}`,
    );
  }
  captured.set('GET /members/me/policy-acceptance', policyRead);

  // ---- a support ticket -------------------------------------------------------
  const ticket = await treq<any>('POST', '/v1/support/tickets', {
    token: member,
    idempotencyKey: key('ticket'),
    body: { topicId: 'wallet', message: 'contract probe', via: 'email' },
  });
  if (ticket.status !== 200) throw new Error(`POST /v1/support/tickets: ${ticket.status} ${ticket.raw}`);
  captured.set('POST /v1/support/tickets', ticket);

  // ---- every GET, captured once ------------------------------------------------
  const gets: Array<[string, string, string]> = [
    [`GET /salons/${SALON_A}`, `/salons/${SALON_A}`, dashboard],
    [`GET /salons/${SALON_A}/metrics`, `/salons/${SALON_A}/metrics`, dashboard],
    [`GET /salons/${SALON_A}/services`, `/salons/${SALON_A}/services`, dashboard],
    [`GET /salons/${SALON_A}/artists`, `/salons/${SALON_A}/artists`, dashboard],
    [`GET /salons/${SALON_A}/artists/bookable`, `/salons/${SALON_A}/artists/bookable`, member],
    [`GET /salons/${SALON_A}/products`, `/salons/${SALON_A}/products`, dashboard],
    [`GET /v1/salons/${SALON_A}/promotions`, `/v1/salons/${SALON_A}/promotions`, dashboard],
    // Both behind perms.marketing, which ST-001 holds. The campaign list is witnessed
    // by the `pending` campaign created earlier in this hook.
    [
      `GET /v1/salons/${SALON_A}/messaging-policy`,
      `/v1/salons/${SALON_A}/messaging-policy`,
      dashboard,
    ],
    [`GET /v1/salons/${SALON_A}/campaigns`, `/v1/salons/${SALON_A}/campaigns`, dashboard],
    ['GET /members/me', '/members/me', member],
    ['GET /members/me/transactions', '/members/me/transactions', member],
    ['GET /members/me/wallet-token', '/members/me/wallet-token', member],
    ['GET /bookings', '/bookings', member],
    ['GET /bookings/{id}', `/bookings/${bookingId}`, member],
    [
      `GET /artists/${A_QUIET_ARTIST}/availability?date={future, unbooked}`,
      `/artists/${A_QUIET_ARTIST}/availability?date=${quietDate}`,
      member,
    ],
    [
      `GET /artists/${A_ARTIST}/availability?date={future, booked}`,
      `/artists/${A_ARTIST}/availability?date=${bookingDate}`,
      member,
    ],
    ['GET /artists/me', '/artists/me', artistScanner],
    ['GET /staff', '/staff', dashboard],
    ['GET /staff/me', '/staff/me', dashboard],
    ['GET /charges', '/charges', scanner],
    /**
     * THE TWO CONSOLE READS, now that a platform credential exists. Both serve shapes this
     * file already probes from the salon side, which is exactly why leaving them unprobed
     * was the drift the census exists to prevent: a route recorded as unreachable when it
     * has a schema is a shape nobody compares.
     */
    ['GET /v1/platform/campaigns', '/v1/platform/campaigns', platform],
    ['GET /v1/platform/messaging-policy', '/v1/platform/messaging-policy', platform],
    ['GET /v1/platform/policies', '/v1/platform/policies', member],
    ['GET /v1/platform/support', '/v1/platform/support', member],
    ['GET /topups/{id}', `/topups/${topUpId}`, member],
  ];

  for (const [label, path, token] of gets) {
    const res = await treq<any>('GET', path, { token });
    captured.set(label, res);
  }
}, 180_000);

afterAll(async () => {
  await stopTenancyApi();
});

function response(label: string): { status: number; body: any; raw: string } {
  const res = captured.get(label);
  if (!res) throw new Error(`No captured response for "${label}" — beforeAll did not record it.`);
  return res;
}

// ===========================================================================
// The sample has to be worth comparing before either direction means anything
// ===========================================================================

describe('the samples are real and not empty', () => {
  for (const probe of probes()) {
    if (!probe.requireNonEmpty) continue;
    it(`${probe.label} carries rows for ${probe.schemaName} to be tested against`, () => {
      const res = response(probe.source ?? probe.label);
      expect(
        [200, 201],
        `${probe.label} answered ${res.status}: ${res.raw.slice(0, 300)}`,
      ).toContain(res.status);
      for (const path of probe.requireNonEmpty!) {
        const value = at(res.body, path);
        expect(
          Array.isArray(value) ? value.length : -1,
          `${probe.label} returned an empty (or missing) \`${path}\`. ` +
            `Comparing ${probe.schemaName} against zero objects cannot fail, so this probe ` +
            'would report green while proving nothing. Fix the fixture, do not relax this.',
        ).toBeGreaterThan(0);
      }
    });
  }

  /**
   * DRIFT (4), AS A STANDING ASSERTION RATHER THAN A COMMENT.
   *
   * `reason` is `.optional()` because the server OMITS the key on an available
   * slot. A `.nullable()` that is not `.optional()` makes it required and every
   * bookable slot fails to parse — which is invisible on today's date, where
   * every slot is past and carries a reason. So the sample this file compares
   * against has to contain BOTH shapes, and this proves it does.
   */
  it('the availability sample contains a slot with no `reason` key at all — the shape that broke', () => {
    const day = response(`GET /artists/${A_ARTIST}/availability?date={future, booked}`);
    const slots = day.body.slots as Array<Record<string, unknown>>;

    const bookable = slots.filter((s) => s.available === true && !('reason' in s));
    const blocked = slots.filter((s) => s.available === false && 'reason' in s);

    expect(
      bookable.length,
      `Not one slot on ${bookingDate} is available with the \`reason\` key absent. That is the ` +
        'exact shape a `.nullable()`-but-not-`.optional()` schema rejects, and without it in ' +
        'the sample this file would pass on the very drift it was written for. If the API has ' +
        'started sending `reason: null` on available slots, that is the change to discuss.',
    ).toBeGreaterThan(0);
    expect(
      blocked.length,
      `Not one slot on ${bookingDate} is unavailable with a \`reason\`. This run booked into ` +
        'that day, so at least the booked slot should carry one.',
    ).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Direction one — a required key the wire does not carry, or a wrong type
// ===========================================================================

describe('every served response satisfies its schema', () => {
  for (const probe of probes()) {
    const spec = probe.knownParseFailure ? knownBug : it;
    const title = `${probe.label} parses as ${probe.schemaName}${
      probe.knownParseFailure ? ` — ${probe.knownParseFailure}` : ''
    }`;

    spec(title, () => {
      const res = response(probe.source ?? probe.label);
      const subject = at(res.body, probe.select);
      const result = probe.schema.safeParse(subject);

      expect(
        result.success,
        `${probe.label} does not satisfy ${probe.schemaName}. A schema that REQUIRES a key the ` +
          'wire does not carry rejects the whole response — that is how every bookable slot in ' +
          'the Book grid failed to parse. What zod objected to:\n' +
          `${describeParseError(result.error)}\n` +
          `--- the response ---\n${res.raw.slice(0, 1200)}`,
      ).toBe(true);
    });
  }
});

// ===========================================================================
// Direction two — a key the wire carried and the parse silently deleted
// ===========================================================================

describe('and no schema is narrower than the wire', () => {
  for (const probe of probes()) {
    // A probe that does not parse at all cannot be compared for stripping, so a
    // known parse failure makes this half a knownBug too — and it goes green the
    // moment the schema is fixed, at which point the real comparison starts.
    const spec = probe.knownStripped || probe.knownParseFailure ? knownBug : it;
    const title = `${probe.label} loses nothing through ${probe.schemaName}${
      probe.knownStripped ? ` — ${probe.knownStripped}` : ''
    }${probe.knownParseFailure ? ' — cannot be compared: it does not parse. See the sibling spec.' : ''}`;

    spec(title, () => {
      const res = response(probe.source ?? probe.label);
      const subject = at(res.body, probe.select);
      const result = probe.schema.safeParse(subject);

      // Nothing to compare if the parse refused the response. That failure is
      // direction one's spec, and reporting it twice would hide which is which.
      if (!result.success) {
        if (probe.knownParseFailure) {
          // Keep this an ASSERTION failure so knownBug() accepts it: the drift is
          // real, it is simply reported by the sibling spec above.
          expect(
            result.success,
            `${probe.label} cannot be compared for stripping because it does not parse at all. ` +
              `See the sibling spec. ${probe.knownParseFailure}`,
          ).toBe(true);
          return;
        }
        throw new Error(
          `${probe.label} does not parse as ${probe.schemaName}, so the stripping comparison ` +
            'could not run. Fix the parse failure reported by the sibling spec first.',
        );
      }

      const deltas = keyDeltas(subject, result.data);
      const annotated = new Set(Object.keys(probe.wireOnly ?? {}));

      const unexplained = deltas.filter((d) => !annotated.has(d.shape));
      expect(
        unexplained.length === 0 ? '' : describeDeltas(unexplained),
        `${probe.schemaName} is not the shape ${probe.label} actually serves.\n\n` +
          'A key the wire carried and the parse deleted is NOT a smaller contract, it is a ' +
          'LOSSY one — zod does not fail to type an undeclared field, it removes it, so a ' +
          'client reads `undefined` with no way to know the server sent a value. This is how ' +
          '`changeableUntil` — the entire one-hour cancellation rule — disappeared between the ' +
          'wire and the screen.\n\n' +
          'Add the field to the schema in packages/types. If the key genuinely belongs to no ' +
          'schema, add it to this probe\'s `wireOnly` WITH A REASON.\n',
      ).toBe('');

      // The annotation is checked in the other direction too, so `wireOnly`
      // cannot quietly become the place drift goes to be forgotten.
      const seen = new Set(deltas.map((d) => d.shape));
      const stale = [...annotated].filter((a) => !seen.has(a));
      expect(
        stale,
        `${probe.label} no longer serves ${stale.join(', ')}, so the \`wireOnly\` note for it is ` +
          'stale. Remove it.',
      ).toEqual([]);
    });
  }
});

// ===========================================================================
// The census — a served shape with no schema is NAMED, not skipped
// ===========================================================================

describe('census — every GET the API registers is either probed or explicitly unmodelled', () => {
  const discovered = discoverGetRoutes();

  it('the route scan actually finds routes (a broken regex must not pass silently)', () => {
    const paths = discovered.map((r) => `GET ${r.path}`);
    for (const known of [
      'GET /salons/:id',
      'GET /salons/:id/services',
      'GET /salons/:id/artists',
      'GET /salons/:id/artists/bookable',
      'GET /artists/:id/availability',
      'GET /bookings',
      'GET /members/me',
      'GET /staff',
      'GET /charges',
      'GET /v1/platform/policies',
    ]) {
      expect(paths, `the GET scan lost ${known}`).toContain(known);
    }
    expect(discovered.length).toBeGreaterThanOrEqual(25);
  });

  it('no GET route is left unclassified', () => {
    const probed = new Set(probes().map((p) => p.route));
    const unmodelled = new Set(Object.keys(UNMODELLED));

    const unclassified = discovered
      .map((r) => ({ route: `GET ${r.path}`, file: r.file }))
      .filter(
        (r) =>
          !probed.has(r.route) &&
          !unmodelled.has(r.route) &&
          // Pending arrivals are classified for THIS check and fail their own,
          // below, the moment they land. Never both green.
          !(r.route in AWAITING_MERGE) &&
          // Served and schema'd but behind a credential the harness cannot mint.
          // Its own spec below fails the hour that stops being true.
          !(r.route in NEEDS_PLATFORM_CREDENTIAL),
      )
      .map((r) => `${r.route}   (${r.file})`);

    expect(
      unclassified,
      'A GET route is served that this file says nothing about. Either add a probe binding it ' +
        'to its schema in packages/types, or add it to UNMODELLED with the reason it has no ' +
        'schema. Silence is the failure mode this census exists to remove:\n  ' +
        unclassified.join('\n  '),
    ).toEqual([]);
  });

  /**
   * THE ARRIVAL CHECK. The other half of `AWAITING_MERGE`, and the reason that map
   * is a note rather than a hole: a pending route is tolerated by the unclassified
   * check above only for as long as it is genuinely absent.
   */
  /**
   * `NEEDS_PLATFORM_CREDENTIAL` IS EMPTY, AND THIS SPEC IS THE RECEIPT.
   *
   * THE MECHANISM WORKED, WHICH IS WHY IT IS DOCUMENTED RATHER THAN DELETED. The map used
   * to hold four routes, excused from the unclassified check on the grounds that this
   * harness could not mint a platform principal — and the spec that stood here asserted
   * exactly that, against the harness's own EXPORTS rather than against a comment, so the
   * capability arriving was the event it would notice.
   *
   * On 2026-08-19 lane D added `signInPlatform` for `campaigns.test.ts`. The next full run
   * (10:44 Kuwait) went red here with the instruction already written: "the harness now
   * exports something that looks like a platform sign-in. NEEDS_PLATFORM_CREDENTIAL is no
   * longer an honest excuse: move those four routes into probes() — two of them already
   * have schemas this file uses from the salon side." That is a self-expiring excuse
   * expiring on its own, one commit after the thing it was waiting for.
   *
   * WHAT HAPPENED TO THE FOUR:
   *   GET /v1/platform/campaigns         → an ordinary probe, paginated(CampaignSchema)
   *   GET /v1/platform/messaging-policy  → an ordinary probe, PlatformMessagingPolicySchema
   *   GET /v1/platform/admins            → UNMODELLED. Reachable now; still has no schema
   *                                        (`PlatformAdmin` is unmodelled in packages/types).
   *   GET /v1/platform/policies/draft    → UNMODELLED. Reachable now; a console shape with
   *                                        no client and no schema.
   *
   * THE LAST TWO MOVED TO `UNMODELLED` AND THAT IS THE HONEST FILE FOR THEM NOW. The
   * distinction the map's own header draws is between "no schema" and "no credential", and
   * only the first is still true of them. Leaving them here would restate a solved problem
   * as a live one — the `knownBug` that outlived its bug, which this suite has been bitten
   * by before.
   *
   * The map and this spec stay in place, inverted, for the next capability that is missing:
   * an empty map costs one passing spec and is the difference between a route being
   * unreachable on purpose and unreachable by neglect.
   */
  it('NEEDS_PLATFORM_CREDENTIAL is empty — every console GET is now probed or unmodelled', async () => {
    const harness = (await import('./support/tenancy-harness.js')) as Record<string, unknown>;
    const platformSignIn = Object.keys(harness).filter(
      (k) => /platform/i.test(k) && /sign|token|principal|session/i.test(k),
    );

    expect(
      platformSignIn.length,
      'the harness lost its platform sign-in. Either restore it, or move the console routes ' +
        'back into NEEDS_PLATFORM_CREDENTIAL with the reason — the census must not go quiet ' +
        'about them.',
    ).toBeGreaterThan(0);

    expect(
      Object.keys(NEEDS_PLATFORM_CREDENTIAL),
      'a route is excused for want of a credential the harness now has. Probe it, or move it ' +
        'to UNMODELLED if what it really lacks is a schema.',
    ).toEqual([]);
  });

  it('nothing in AWAITING_MERGE has landed yet — the hour one does, classify it properly', () => {
    const served = new Set(discovered.map((r) => `GET ${r.path}`));
    const arrived = Object.keys(AWAITING_MERGE).filter((r) => served.has(r));

    expect(
      arrived,
      'A route this file was told to expect is now SERVED, so it must stop being a note and ' +
        'become a classification. Do what its entry says, then delete the entry:\n\n' +
        arrived.map((r) => `  ${r}\n    ${AWAITING_MERGE[r]}`).join('\n\n') +
        '\n',
    ).toEqual([]);
  });

  it('every UNMODELLED entry names a route that is actually served', () => {
    const served = new Set(discovered.map((r) => `GET ${r.path}`));
    const ghosts = Object.keys(UNMODELLED).filter((r) => !served.has(r));
    expect(ghosts, `UNMODELLED names routes the API no longer serves: ${ghosts.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * THE `ProductSchema is UNWITNESSED` SPEC STOOD HERE AND HAS DONE ITS JOB.
   *
   * `ProductSchema` was the one schema in `packages/types` with no live sample
   * anywhere — the seed created no products, so `GET /salons/{id}/products` returned
   * `{items: []}` on every fresh database and there was no write endpoint to make one
   * with. A parse of an empty array witnesses the envelope and says nothing at all
   * about the element shape, which is the kind of green worth distrusting.
   *
   * It was written as an ASSERTION rather than a comment so the gap would close
   * itself, and that is exactly what happened: lane A seeded the shop, this spec went
   * red naming PR-01, PR-02 and PR-03, and the instruction it carried — move the route
   * into `probes()` with `requireNonEmpty: ['items']` — is now done. The route is a
   * real probe and the census exemption is gone.
   *
   * Recorded rather than silently deleted, because the mechanism is the point: a
   * placeholder that expires on contact with the thing it is waiting for is the shape
   * this census uses everywhere, and it has now paid off five times (four route
   * arrivals and this).
   */
});

// ===========================================================================
// WIRE PINS — the shapes `packages/types` has no schema for at all
// ===========================================================================

/**
 * Four routes, two shapes, no schema anywhere, and the wallet's Account screen
 * built on all four.
 *
 * The rest of this file compares a response against a schema. These have none, so
 * they cannot drift against one — they drift against the CLIENT, silently, in the
 * same direction and with the same symptom: a field the screen reads stops
 * arriving and nothing anywhere goes red. `changeableUntil` was that, and it had a
 * schema to be lost from; a shape with no schema does not even have that much.
 *
 * So the schema's side is declared here and compared both ways. See `wireShape`.
 */
interface WirePin {
  /** The captured response's key. */
  label: string;
  /** The exact key set the wire serves. Values are ignored; only shape is pinned. */
  wire: unknown;
  /** Why this shape matters to somebody, in the terms the project already uses. */
  why: string;
}

/**
 * THE NEVER-ASKED CONSENT RECORD, and every leaf of it is a decision.
 *
 * `granted: false` with `at`, `source` and `policyVersion` all null is "she has
 * never been asked" — services/consent.ts is explicit that this is NOT the same
 * fact as "she said no", and NOT "unknown", and NOT "assume yes". Non-negotiable
 * #8 makes the send path read this record; a client or a sender that could not
 * tell those apart would be guessing about consent, which is the one thing there
 * is no defensible guess about.
 *
 * All three nulls are pinned AS PRESENT KEYS. An API that omitted them until she
 * answered would serve an identical-looking screen and a different contract.
 */
const NEVER_ASKED_CONSENT = { granted: false, at: null, source: null, policyVersion: null };

const NOTIFICATIONS_WIRE = {
  push: true,
  remind: true,
  wa: true,
  receipt: true,
  /**
   * Flattened for the switch to bind to, AND carried in full beside it. Both, on
   * purpose: routes/members.ts says a response with only the boolean "would make
   * the event storage pointless to everyone but the database". So the pin holds
   * both, and a fix that drops either half is drift.
   */
  offers: false,
  offersConsent: NEVER_ASKED_CONSENT,
};

const DELETION_WIRE = {
  requestedAt: null,
  erasureDueAt: null,
  status: 'pending',
  /**
   * `graceDays` is the 30 the privacy policy publishes and the wallet's copy
   * repeats. Served rather than hardcoded in the client for the reason
   * non-negotiable #10 exists: the number is part of a legal promise, so the
   * screen must render the server's, not its own.
   */
  graceDays: 30,
  /**
   * The honest bit, and the one most likely to be "tidied away" by someone who
   * reads it as redundant. A client has to be able to tell "we have your request
   * and the clock is running" from "it has been carried out" — the erasure job is
   * not built, and a response that implied otherwise would make the confirmation
   * screen say something untrue.
   */
  erasureScheduled: false,
};

/**
 * The #10 re-prompt state, as served by both of its doors.
 *
 * `accepted` IS SAMPLED POPULATED, DELIBERATELY, and this is the trap the pin had
 * to be built around. `wireShape` walks values, so a null `accepted` collapses to
 * the single leaf `$.accepted` and the three keys inside it vanish from the pin —
 * which would then keep passing on the day the API stopped serving
 * `accepted.source`. The capture in `beforeAll` therefore POSTs the acceptance
 * before reading, and asserts the sample is non-null before trusting it.
 *
 * Values here are only ever read for their SHAPE, but they are written truthfully
 * anyway: version 3 effective 2026-07-01 is what `api/src/db/seed.ts` publishes,
 * and `wallet_account` is the source the Account surface records rather than
 * `signup` — which would have the trail claim she agreed at registration to a
 * document published afterwards.
 */
const POLICY_ACCEPTANCE_WIRE = {
  published: { version: 3, effectiveFrom: '2026-07-01', publishedAt: '2026-06-01T06:00:00.000Z' },
  accepted: { version: 3, at: '2026-08-19T00:00:00.000Z', source: 'wallet_account' },
  /**
   * The cached projection, carried BESIDE the evidence rather than instead of it.
   * `services/policy.ts` is explicit that `upToDate` is not computed from it, and a
   * `stampedVersion` with a null `accepted` is precisely the pre-0025 member whose
   * agreement nobody can produce — so a pin that dropped either key would hide the
   * one state this shape exists to make visible.
   */
  stampedVersion: 3,
  upToDate: true,
};

function wirePins(): WirePin[] {
  return [
    {
      label: 'GET /members/me/policy-acceptance',
      wire: POLICY_ACCEPTANCE_WIRE,
      why:
        'the wallet decides whether to put the terms in front of her again from this one read. ' +
        '`upToDate` false is the re-prompt; a client that read `undefined` would take it as ' +
        'falsy and re-prompt for ever, and one that read a missing `published.version` could ' +
        'not tell her which document she is being asked about. Non-negotiable #10: the customer ' +
        'app holds no legal copy and stamps the version it was served.',
    },
    {
      label: 'POST /members/me/policy-acceptance',
      wire: POLICY_ACCEPTANCE_WIRE,
      why:
        'the write answers with the same decision state, so the wallet can dismiss the re-prompt ' +
        'without a second round trip. IDENTICAL to the GET by design: one decision, two routes.',
    },
    {
      label: 'GET /members/me/notifications',
      wire: NOTIFICATIONS_WIRE,
      why:
        'the Account screen\'s five switches and the consent record behind the fifth. Four of ' +
        'them are not client-owned at all — the receipt outbox does not consult a phone before ' +
        'it queues a message — so a preference lost between the wire and the screen is a false ' +
        'statement made to the customer, not a lost setting.',
    },
    {
      label: 'PATCH /members/me/notifications',
      wire: NOTIFICATIONS_WIRE,
      why:
        'the write answers with the same screen-shaped read, so the client can render the result ' +
        'without a second round trip. IDENTICAL to the GET by design: one screen, two routes.',
    },
    {
      label: 'POST /members/me/deletion',
      wire: DELETION_WIRE,
      why:
        'the confirmation screen for the most destructive thing the wallet offers. `requestedAt` ' +
        'and `erasureDueAt` are what make "removed within 30 days" a statement about something.',
    },
    {
      label: 'GET /members/me/deletion',
      wire: DELETION_WIRE,
      why:
        'the deletion state as a READ — lane A added it so the wallet could render the pending ' +
        'banner without POSTing to find out. Pinned against the SAME constant as the two writes, ' +
        'which is the point: three routes serving one state, and a read that drifts from the ' +
        'writes is a banner that disagrees with the button beside it.',
    },
    {
      label: 'DELETE /members/me/deletion',
      wire: DELETION_WIRE,
      why:
        'the way back out of the grace window. Same five keys as the request, with the two ' +
        'instants null and `status: "none"` — the shape is the state, so one shape serves both.',
    },
  ];
}

describe('wire pins — the served shape of what packages/types does not model yet', () => {
  for (const pin of wirePins()) {
    it(`${pin.label} still serves exactly the key set this suite pinned`, () => {
      const res = response(pin.label);
      expect([200, 201], `${pin.label} answered ${res.status}: ${res.raw.slice(0, 300)}`).toContain(
        res.status,
      );

      const served = wireShape(res.body);
      const declared = wireShape(pin.wire);

      const missing = declared.filter((k) => !served.includes(k));
      const extra = served.filter((k) => !declared.includes(k));

      expect(
        missing,
        `${pin.label} NO LONGER SERVES ${missing.join(', ')}.\n\n` +
          'This is the direction that bites. There is no schema in packages/types for this ' +
          'shape, so nothing else in this repository would have noticed: the wallet reads ' +
          '`undefined` and cannot tell that from a value the server chose not to send. ' +
          `Why the shape matters: ${pin.why}\n\n` +
          'If the field was renamed or genuinely removed, update the pin AND say so in the ' +
          'lane report — a client is built on it.\n' +
          `--- what was served ---\n${res.raw.slice(0, 800)}\n`,
      ).toEqual([]);

      expect(
        extra,
        `${pin.label} now serves ${extra.join(', ')}, which this pin does not declare.\n\n` +
          'Benign on its own — nothing is lost by a response growing — but the pin is the only ' +
          'record of this shape that exists, and a pin nobody updates stops being evidence of ' +
          'anything. Add the key here, and consider whether the shape has earned a schema in ' +
          'packages/types instead (at which point delete the pin and add a probe).\n' +
          `--- what was served ---\n${res.raw.slice(0, 800)}\n`,
      ).toEqual([]);
    });
  }

  /**
   * ONE SCREEN, TWO ROUTES, AND THE WALLET BINDS THE SAME STATE TO BOTH.
   *
   * Asserted against each other rather than only against the pin, because the pin
   * is one constant used twice and so cannot catch the case where a fix widens one
   * handler and not the other — both would have to be edited to make that spec
   * pass, and a reader editing the pin would make it pass by accident. Comparing
   * the two live responses cannot be satisfied that way.
   */
  it('the notifications GET and PATCH serve the same shape — one screen reads both', () => {
    const get = wireShape(response('GET /members/me/notifications').body);
    const patch = wireShape(response('PATCH /members/me/notifications').body);
    expect(
      patch,
      'PATCH /members/me/notifications answers with a different key set than the GET does. The ' +
        'Account screen renders the write\'s response to avoid a second round trip, so a key ' +
        'present on one and absent on the other is a switch that appears to work and then ' +
        'reverts on the next open.',
    ).toEqual(get);
  });

  /**
   * THREE ROUTES, ONE STATE, COMPARED LIVE.
   *
   * The pins above all reference DELETION_WIRE, so editing that one constant would
   * satisfy all three at once. Comparing the responses to EACH OTHER cannot be
   * satisfied that way — it needs three handlers to actually agree.
   */
  it('the deletion READ serves the same shape as the two writes — a banner cannot disagree with its button', () => {
    const read = wireShape(response('GET /members/me/deletion').body);
    expect(
      read,
      'GET /members/me/deletion answers with a different key set than POST does. The wallet ' +
        'renders the pending banner from the read and the confirmation from the write, so a key ' +
        'on one and not the other is a banner that contradicts the screen that produced it.',
    ).toEqual(wireShape(response('POST /members/me/deletion').body));
    expect(read).toEqual(wireShape(response('DELETE /members/me/deletion').body));
  });

  /**
   * The same argument for the policy pair, and here the consequence is a legal one.
   *
   * Non-negotiable #10 makes the served version part of the record: the wallet
   * stamps what it was given. If the read and the write disagree about where the
   * version lives, the stamp is taken from one shape and the re-prompt decided from
   * the other.
   */
  it('the policy-acceptance READ and WRITE serve the same decision state', () => {
    const read = wireShape(response('GET /members/me/policy-acceptance').body);
    expect(
      read,
      'GET and POST /members/me/policy-acceptance answer with different key sets. The wallet ' +
        'decides the re-prompt from the read and dismisses it from the write, so a key on one ' +
        'and not the other is a prompt that cannot be dismissed by the tap that answers it.',
    ).toEqual(wireShape(response('POST /members/me/policy-acceptance').body));

    /**
     * AND `accepted` REALLY WAS POPULATED. Without this the spec above is satisfied
     * by two responses that both collapsed `accepted` to null — equal to each other
     * and blind to the three keys inside, which is the whole shape the pin is for.
     */
    expect(
      read,
      'the sample had a null `accepted`, so the pin above declares nothing about its contents',
    ).toContain('$.accepted.source');
    expect(read).toContain('$.accepted.version');
    expect(read).toContain('$.accepted.at');
  });

  /** Same argument for the deletion pair: the shape IS the state. */
  it('the deletion POST and DELETE serve the same shape — the shape is the state', () => {
    const requested = wireShape(response('POST /members/me/deletion').body);
    const cancelled = wireShape(response('DELETE /members/me/deletion').body);
    expect(
      cancelled,
      'the cancel answers with a different key set than the request does, so a client cannot ' +
        'hold one state object for the deletion section of the Account screen.',
    ).toEqual(requested);
  });

  /**
   * THE PIN IS NOT A SUBSTITUTE FOR A SCHEMA, and this spec is where that is
   * written down rather than left in a comment nobody re-reads.
   *
   * It goes RED the day either shape gets a schema in `packages/types`, which is
   * the moment the pin should be deleted and a real probe added — the pin is
   * hand-maintained and a probe is not, so leaving both would mean the weaker
   * guard is the one still being edited.
   */
  it('and neither shape has a schema yet — the day one does, delete its pin and add a probe', async () => {
    const types: Record<string, unknown> = await import('../packages/types/dist/index.js');
    const arrived = [
      'NotificationPreferencesSchema',
      'NotificationSettingsSchema',
      'MemberNotificationsSchema',
      'ConsentStateSchema',
      'MarketingConsentSchema',
      'AccountDeletionSchema',
      'DeletionStateSchema',
      'DeletionRequestSchema',
      'PolicyAcceptanceStateSchema',
      'PolicyAcceptanceSchema',
      'PublishedPolicySetSchema',
    ].filter((name) => name in types);

    expect(
      arrived,
      `packages/types now exports ${arrived.join(', ')}. If that is the schema for one of the ` +
        'shapes pinned above, the pin has been superseded: move the route into probes() bound ' +
        'to the real schema, delete the pin, and remove the route from UNMODELLED. Two guards ' +
        'over one shape means the hand-written one is the one still being maintained.',
    ).toEqual([]);
  });
});
