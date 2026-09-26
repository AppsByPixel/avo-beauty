/**
 * Salon reads and edits. Four of the nine permission gates live here.
 *
 *   GET    /salons/{id}/metrics         perms.dashboard
 *   GET    /salons/{id}/products        perms.shop for staff, open to her own members
 *                                       — and it now emits `image`, which
 *                                       ProductSchema does not declare yet. See
 *                                       the route, and routes/images.ts.
 *   POST   /salons/{id}/products        perms.shop
 *   PATCH  /salons/{id}/products/{pid}  perms.shop
 *   DELETE /salons/{id}/products/{pid}  perms.shop — retires, does not delete
 *   GET    /salons/{id}/bookings        perms.appointments
 *   PATCH  /salons/{id}                 perms.loyalty
 *   PATCH  /v1/salons/{id}/social/{linkId}   perms.loyalty — and that name is
 *                                       wrong; see the route for what should
 *                                       replace it and why this lane may not.
 *
 * PATCH is the one that matters most. The loyalty editor writes through it, and
 * build-plan.md calls a half-published tier ladder a money bug — a member who
 * tops up between two writes gets a bonus from a ladder that does not exist yet.
 * The ladder is one jsonb column precisely so a publish is a single row update
 * and cannot half-write; the gate here is what stops someone without loyalty
 * authority reaching it at all.
 *
 * `GET /salons/{id}` itself is not gated: the customer wallet renders the salon
 * name, brand colour, business hours and social links, so it is readable by any
 * authenticated principal of that salon and serialised without anything
 * merchant-only in it.
 */

import { socialUrl, type Fils } from '@avo/types';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { product } from '../db/schema/product';
import { branch, salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { staffUser } from '../db/schema/staff';
import {
  requireDashboardPerm,
  requireSalonScoped,
  requireSameSalon,
} from '../auth/principal';
import { badRequest, conflict, loyaltyReadOnly, notFound } from '../http/errors';
import { parseBusinessHours, parseE164 } from '../http/fields';
import { serialiseMemberContact } from '../http/serialise';
import { parseAmountFils, requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { assertBookingReadable, assertShopReadable } from '../services/moduleAccess';
import { parseBrandColor } from '../services/brandColor';
import { branchClosureImpact } from '../services/branchClosure';
import {
  afterCursor,
  cursorInstant,
  encodeCursor,
  parseCursor,
} from '../services/streamCursor';
import { deviceEnrolment } from '../db/schema/deviceEnrolment';
import { resolveBranchFilter } from '../services/branchFilter';
import { primaryImagesFor } from '../services/imageAttachment';
import { parseLoyaltyConfig } from '../services/loyaltyRules';
import {
  applySocialPatch,
  isSocialId,
  parseSocialHandle,
  parseSocialLinks,
  parseSocialOn,
  SOCIAL_IDS,
} from '../services/socialLinks';
import { serialiseBooking, type BookingRow } from '../services/booking';
import { computeMetrics } from '../services/metrics';
import {
  parseCalendarRange,
  parsePeriod,
  resolveWindow,
  type PeriodWindow,
} from '../services/period';
import { parseTimeZone } from '../time/zone';
import { loyaltyConfigOf } from './loyalty';

/** api-contract.md § Booking — the four statuses, and the merchant's status pills. */
const BOOKING_STATUSES = ['deposit_held', 'completed', 'no_show_returned', 'cancelled'] as const;

/** Fields a merchant may edit. Anything else in the body is refused, not ignored. */
/**
 * EXPORTED so `salons.test.ts` can assert against the REAL set.
 *
 * It used to recover this set by difference — `PLATFORM_EDITABLE` minus `city`
 * and `ownerPhone` — with the comment "the merchant set is module-private". That
 * held only while those two were the ONLY difference, and the loyalty reversal
 * ended it: the reconstruction silently kept the five loyalty fields in its idea
 * of the merchant set, so the suite went on passing while testing a set the
 * product no longer has. A test that derives its expectation from the thing it is
 * testing cannot fail when the thing changes, which is the failure mode this
 * whole file exists to prevent one layer down.
 */
export const MERCHANT_EDITABLE = new Set([
  'name',
  /**
   * `{ booking, shop }` — the shape `GET /salons/{id}` serves and the shape
   * api-contract.md § Salon defines. Stored as two boolean columns, so this is
   * the one editable field whose wire name is not its column name; the split
   * happens in `applyModules` below.
   *
   * The COLUMN spellings (`moduleBooking` / `moduleShop`) are deliberately NOT
   * accepted. Two doors into one field is how the tier ladder acquired an
   * unvalidated second entrance, and a client that can spell a field two ways
   * will eventually spell it both ways in one request. Lane C reads `modules`
   * from the GET; it writes the same word back.
   */
  'modules',
  // `name` and `stampReward` are editable, so their Arabic twins are too. A
  // field the API serves but nothing can ever set is the same half-implemented
  // state this change exists to close: it would leave the Arabic name settable
  // only by a hand-written UPDATE.
  'nameAr',
  /**
   * Editable, and — since `services/brandColor.ts` landed — validated through
   * `deriveBrandSet()` on the way in, which is what non-negotiable #9's second
   * clause asks for and what nothing here did before.
   *
   * It sat in this set from the day the route was written with no guard but the
   * database's six-hex-digit regex, so `#FFFF00` was a storable brand colour and
   * every surface then painted white text on a 1.25:1 fill. See that module's
   * header; the same function guards `POST /v1/platform/salons`, because a check
   * on one of two doors into one column is the hole the tier ladder had.
   */
  'brandColor',
  /**
   * `loyaltyMode`, `tiers`, `stampTarget`, `stampReward` and `stampRewardAr`
   * WERE HERE, AND ARE NOW CONSOLE-ONLY. See `LOYALTY_FIELDS` below: loyalty
   * authority moved from the merchant to AVO, and this was the OTHER door into
   * it. Removing them from this set is the half of that change that is easy to
   * forget, because the endpoint everyone thinks of is `PUT /salons/{id}/loyalty`.
   */
  'depositFils',
  'noShowReturnMinutes',
  /**
   * Editable, and validated as an IANA id rather than stored verbatim.
   *
   * It decides what "10:00" means for business hours, artist windows and every
   * happy-hour window, so an unvalidated string here would not fail loudly — it
   * would make `Intl.DateTimeFormat` throw inside a charge, three screens away
   * from the field that was typed wrong. See `parseTimeZone`.
   */
  'timezone',
  'businessHours',
  'social',
  'whatsappEnabled',
  /**
   * The other half of the receipt channel choice (DECISIONS.md #88). Both are
   * editable; `salon_receipt_channel_floor` is what stops her choosing neither,
   * and `receipt_channels_required` below is the message rather than a 500.
   */
  'emailEnabled',
]);

/**
 * The two fields ONLY AVO SETS, and the reason they are not in the set above.
 *
 * `city` and `ownerPhone` arrived with the onboarding wizard (migration 0037) and
 * until now had exactly one door: creation. A salon that moves, or an owner whose
 * number changes, had no way to correct either — and a field the API serves but
 * nothing can ever set is the half-implemented state `nameAr`'s comment above
 * describes.
 *
 * THEY ARE ACCOUNT FACTS, NOT SETTINGS. `city` is the registered location AVO
 * bills and reports against; `ownerPhone` is the number AVO calls and the
 * destination of the owner's invite. A salon changing either about itself is the
 * account changing, which is the console's business — the same line the design
 * draws by rendering both read-only in the editor header while making modules,
 * deposit and loyalty editable there.
 *
 * `plan` IS DELIBERATELY IN NEITHER SET. It prices the account, the design puts
 * per-salon plan and fee in the BILLING section, and Billing has no API behind it
 * at all. Adding a plan write here would be inventing the cheap half of a
 * subscription model. Reported, not built.
 */
const PLATFORM_ONLY_EDITABLE = new Set([
  'city',
  'ownerPhone',
  /**
   * THE FIVE LOYALTY FIELDS, MOVED HERE FROM `MERCHANT_EDITABLE`.
   *
   * A REVERSAL, NOT A GAP — routes/loyalty.ts carries the argument in full, and
   * `design/README.md:136` records the decision being reversed ("merchants now
   * edit their own tier rules"). They are console-only for the same reason
   * `PUT /salons/{id}/loyalty` is: Aftab moved the authority to AVO.
   *
   * They belong in the console set rather than in neither set, because the
   * console's salon editor genuinely draws them — "loyalty structure with tier
   * thresholds/bonuses or stamp target", per `PLATFORM_EDITABLE`'s own note —
   * and `PATCH /v1/platform/salons/{id}` is gated on `sections.salons`, which is
   * exactly the gate the loyalty PUT now takes. Same authority, same fields, two
   * routes that were already a superset pair. Nothing widens.
   *
   * `city` and `ownerPhone` are here because they are ACCOUNT FACTS. These five
   * are here for a different reason — a withdrawn capability — and the
   * distinction is worth keeping in view: if the loyalty decision is ever
   * reversed back, these five move and those two do not.
   */
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
]);

/**
 * What `PATCH /v1/platform/salons/{id}` accepts: everything a merchant may edit,
 * plus the two above.
 *
 * A SUPERSET, NOT A PARALLEL SET, and that is the whole point. The console's
 * editor draws "modules, deposit, loyalty structure with tier thresholds/bonuses
 * or stamp target, branches" — fields `PATCH /salons/{id}` has accepted since it
 * was written. Giving the console its own spelling of them would be the second
 * door the `modules` comment above refuses, and the console's copy is the one
 * nobody would be watching.
 */
export const PLATFORM_EDITABLE: ReadonlySet<string> = new Set([
  ...MERCHANT_EDITABLE,
  ...PLATFORM_ONLY_EDITABLE,
]);

/**
 * The nullable Arabic columns, and the only fields on this route where an empty
 * string is not a value.
 *
 * `'' ?? name` is `''` — a blank Arabic name defeats the client's fallback and
 * paints an empty heading, which is why the CHECK constraint refuses it. Coerced
 * here rather than 400'd because clearing a translation is a legitimate thing to
 * want, and "" is how an emptied text input arrives. Without this, clearing the
 * field would surface as a constraint violation, i.e. a 500 on a valid intent.
 */
const NULLABLE_ARABIC = new Set(['nameAr', 'stampRewardAr']);

/**
 * The fields that describe what a visit and a top-up are worth. Touching any of
 * them sends the whole loyalty configuration through the publish validator —
 * see the block comment in the PATCH handler.
 *
 * SINCE THE AUTHORITY REVERSAL, this set does a second job: it is what
 * `buildSalonPatch` matches on to refuse a MERCHANT these fields with the true
 * reason rather than a generic `not_editable`. Both jobs are the same list, and
 * it is one list on purpose — a second copy is the defect this file records
 * against the tier ladder twice already.
 */
const LOYALTY_FIELDS = new Set([
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
]);

function normaliseArabic(key: string, value: unknown): unknown {
  if (!NULLABLE_ARABIC.has(key)) return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `${key} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * THE NUMERIC FIELDS, REFUSED AT THE DOOR RATHER THAN AT THE COLUMN.
 *
 * `depositFils: 5500.5` used to go into the patch object exactly as it arrived.
 * Postgres refused it on the bigint column — the money was never at risk, and
 * non-negotiable #1 held — but the refusal reached the merchant as
 * `server_error`, "Something went wrong on our side". She cannot tell a typed
 * "5.5" from an outage, and the API logged an unhandled error every time
 * somebody mistyped a number.
 *
 * This is the same treatment `timezone` already had, and for the reason its
 * comment gives: a validated field fails with a sentence naming the field, an
 * unvalidated one fails somewhere else as somebody else's problem.
 *
 * The RANGE is checked here as well as by `salon_deposit_in_range`, so 500 fils
 * is a sentence about the range instead of a constraint-violation 500. Both
 * still exist: the CHECK is the guarantee, this is the explanation.
 */
const DEPOSIT_MIN_FILS = 1_000;
const DEPOSIT_MAX_FILS = 10_000;

/**
 * EXPORTED, so `POST /v1/platform/salons` refuses a bad deposit with the same
 * sentence rather than a second one saying the same thing slightly differently.
 * The onboarding wizard's stepper and the merchant's Settings stepper are the two
 * doors into one column and one range; the message a merchant reads should not
 * depend on which of them she came through.
 */
export function parseDepositFils(value: unknown): Fils {
  const n = parseAmountFils(value, 'depositFils');
  if (n < DEPOSIT_MIN_FILS || n > DEPOSIT_MAX_FILS) {
    throw badRequest(
      'deposit_out_of_range',
      `The booking deposit has to be between ${DEPOSIT_MIN_FILS / 1000}.000 and ${DEPOSIT_MAX_FILS / 1000}.000 KD.`,
    );
  }
  return n;
}

/**
 * THE NO-SHOW RETURN WINDOW HAD NO CEILING, and one number is TWO windows.
 *
 * This guard refused only `<= 0`, so `525600` was accepted and stored — one year
 * is a storable no-show window today, driven against the real API. The CHECK
 * behind it said the same thing and no more (`salon_no_show_return_positive`,
 * `> 0`), so nothing anywhere stated an upper bound.
 *
 * WHY A BOUND IS NOT MERELY TIDINESS. The column is read in two places that want
 * opposite things from it:
 *
 *   services/booking.ts § markNoShow   stamps `no_show_return_due_at` at
 *                                      `ends_at + noShowReturnMinutes`. This is
 *                                      the window the merchant thinks she is
 *                                      setting: how long a missed slot's deposit
 *                                      waits before it goes back to the wallet.
 *
 *   services/booking.ts § findApplicableHold
 *                                      reuses it as the EARLY-ARRIVAL GRACE at
 *                                      the counter: `starts_at <= now +
 *                                      noShowReturnMinutes` decides which held
 *                                      deposit a charge may consume.
 *
 * So the same integer both delays a refund and widens the set of appointments a
 * till may spend a deposit against, and the two failure directions are not
 * symmetric:
 *
 *   TOO SHORT  a customer who checks in ten minutes early finds her own deposit
 *              inapplicable — she paid it, and the till cannot see it.
 *   TOO LONG   the grace reaches a DIFFERENT appointment. At 525600 every hold
 *              that member has is "arriving now", so a charge consumes whichever
 *              one `findApplicableHold` orders first.
 *
 * THE BOUND: 5 ≤ n ≤ 1440, which is Lane C's recommendation adopted as-is.
 *
 *   1440 is one day, and it is where the grace certainly crosses into another
 *   day's booking — the same slot next week is still further away, but the same
 *   slot tomorrow is not. Above a day the second reading stops being a grace and
 *   becomes "any hold this member has".
 *
 *   5 rather than 1, so the till can still see a deposit at check-in. A one-minute
 *   grace means an appointment at 10:00 is invisible to `findApplicableHold` at
 *   09:58, which is the TOO SHORT failure above written into the settings screen.
 *
 * Neither number is derived from anything the design states — the bundle draws a
 * static sentence and no control at all (`AVO Merchant Dashboard.dc.html:1059`) —
 * so they are a CHOICE, recorded here and re-stated by `salon_no_show_return_in_range`
 * in migration 0051. Widening either end is a migration, deliberately.
 */
const NO_SHOW_RETURN_MIN_MINUTES = 5;
const NO_SHOW_RETURN_MAX_MINUTES = 1_440;

function parseNoShowReturnMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(
      'invalid_no_show_window',
      'noShowReturnMinutes must be a whole number of minutes.',
    );
  }
  if (value < NO_SHOW_RETURN_MIN_MINUTES || value > NO_SHOW_RETURN_MAX_MINUTES) {
    throw badRequest(
      'invalid_no_show_window',
      `noShowReturnMinutes must be between ${NO_SHOW_RETURN_MIN_MINUTES} and ${NO_SHOW_RETURN_MAX_MINUTES} minutes.`,
    );
  }
  return value;
}

/**
 * `modules: { booking, shop }` → the two boolean columns.
 *
 * A partial object is a partial update: `{ booking: true }` leaves Shop alone,
 * because the Settings screen has two independent switches and sending the pair
 * on every flip would let a stale render turn the other one off.
 */
function applyModules(value: unknown, patch: Record<string, unknown>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_request', 'modules must be an object like { booking, shop }.');
  }
  const incoming = value as Record<string, unknown>;
  for (const key of Object.keys(incoming)) {
    if (key !== 'booking' && key !== 'shop') {
      throw badRequest('unknown_module', `Unknown module: ${key}. The modules are booking and shop.`);
    }
  }
  for (const [key, column] of [
    ['booking', 'moduleBooking'],
    ['shop', 'moduleShop'],
  ] as const) {
    if (key in incoming) {
      if (typeof incoming[key] !== 'boolean') {
        throw badRequest('invalid_request', `modules.${key} must be true or false.`);
      }
      patch[column] = incoming[key];
    }
  }
}

/**
 * THE Salon WIRE SHAPE — one function, so a read and a write cannot disagree.
 *
 * This existed only inside the GET handler, and `PATCH` answered
 * `reply.send(after)` — the raw Drizzle row, carrying `moduleBooking` and
 * `moduleShop` instead of `modules`, and no `branches` at all. Lane C cached
 * that response as the new salon, which is what any reasonable client does with
 * a 200 from a write, and every consumer of `salon.branches` got `undefined` on
 * the next render. It took the whole Settings section to its error boundary.
 * The workaround — stop caching the write, re-GET — works and means the write
 * endpoint is telling the truth to nobody.
 *
 * `branches` carries only OPEN branches: a closed one is history, and every
 * client renders this list as the places a customer can be sent to.
 *
 * EXPORTED for `POST /v1/platform/salons`, which is a third writer of this
 * shape. The header's own rule is why: one function, so a read and a write
 * cannot disagree. `serialiseStaff` and `serialisePlatformAdmin` are exported
 * from their route modules for the same reason.
 */
type SalonRow = typeof salon.$inferSelect;

/**
 * The wire shape, DECLARED rather than inferred — the same treatment `MemberView`
 * gets in routes/auth.ts, and for a reason that is not style.
 *
 * `depositFils` is a branded `Fils` on the row and a plain `number` here, because
 * the brand is a guarantee about arithmetic INSIDE the server and JSON has no
 * brands. Inferring the return type of an exported function instead made `tsc`
 * refuse it outright — TS4058, "using name 'FilsBrand' from external module …
 * but cannot be named", since the brand symbol is deliberately not exported from
 * `@avo/types`. So the boundary where money stops being `Fils` is stated here, in
 * the type, at the exact place the value leaves the process.
 *
 * The columns' own types are reused (`SalonRow['plan']`, `['tiers']`,
 * `['businessHours']`, `['social']`) rather than re-spelled, so a schema change
 * moves this shape with it instead of drifting from it.
 */
export interface SalonView {
  id: string;
  name: string;
  nameAr: string | null;
  city: string | null;
  plan: SalonRow['plan'];
  brandColor: string;
  modules: { booking: boolean; shop: boolean };
  loyaltyMode: SalonRow['loyaltyMode'];
  tiers: SalonRow['tiers'];
  stampTarget: number | null;
  stampReward: string | null;
  stampRewardAr: string | null;
  /** Integer fils. `Fils` on the way in, a plain number on the wire. */
  depositFils: number;
  noShowReturnMinutes: number;
  timezone: string;
  businessHours: SalonRow['businessHours'];
  branches: BranchView[];
  social: SalonRow['social'];
  whatsappEnabled: boolean;
  emailEnabled: boolean;
}

export interface BranchView {
  id: string;
  salonId: string;
  name: string;
  nameAr: string | null;
}

export function serialiseSalon(
  s: typeof salon.$inferSelect,
  branches: Array<typeof branch.$inferSelect>,
): SalonView {
  return {
    id: s.id,
    name: s.name,
    // Emitted whether or not it is set, and emitted as JSON `null` when it is
    // not. An OMITTED key and a null are the same thing to `??`, which is
    // exactly why the missing implementation went unnoticed — so the absent
    // case is now a value the client can actually see and a spec can actually
    // assert on. What must never reach a client is the STRING "null".
    nameAr: s.nameAr,
    /**
     * "Salmiya". NULLABLE, and emitted null rather than omitted, for exactly the
     * reason `nameAr` above is.
     *
     * NEW, and a reported contract addition — see migration 0037. The
     * onboarding wizard's step 1 collects it as one of its three required
     * fields, `AVO Owner Console.dc.html` renders it in the salon list row and
     * the editor header ("Salmiya · Growth plan · 1,284 members"), and until
     * 0037 there was no column, which is what made
     * `GET /v1/platform/salons` say "NO `city`" and serve `branchCount`
     * instead. `packages/types`' `SalonSchema` does not carry it yet; that is
     * trunk's to add, and a Zod parse strips it meanwhile rather than failing.
     *
     * `ownerPhone` is deliberately NOT here. See the migration: this endpoint is
     * readable by any authenticated principal of the salon, members included,
     * and the owner's personal WhatsApp number is not a customer-facing fact.
     */
    city: s.city,
    plan: s.plan,
    brandColor: s.brandColor,
    modules: { booking: s.moduleBooking, shop: s.moduleShop },
    loyaltyMode: s.loyaltyMode,
    tiers: s.tiers,
    stampTarget: s.stampTarget,
    stampReward: s.stampReward,
    stampRewardAr: s.stampRewardAr,
    depositFils: s.depositFils,
    noShowReturnMinutes: s.noShowReturnMinutes,
    /**
     * Emitted to every surface, not just the dashboard. `businessHours` right
     * below it is naive wall clock and means nothing without this — a wallet
     * that renders "Open until 21:00" is rendering a string in a zone it was
     * never told. The clients also need it to resolve `isHappyHourLive`
     * themselves, every second, which is the whole point of there being no
     * `live` flag.
     */
    timezone: s.timezone,
    businessHours: s.businessHours,
    branches: branches.map(serialiseBranch),
    social: s.social,
    whatsappEnabled: s.whatsappEnabled,
    /** Served alongside its twin, so a client can render the real three states. */
    emailEnabled: s.emailEnabled,
  };
}

/** api-contract.md § Branch. `nameAr` for the reason db/schema/salon.ts gives. */
function serialiseBranch(b: typeof branch.$inferSelect): BranchView {
  return { id: b.id, salonId: b.salonId, name: b.name, nameAr: b.nameAr };
}

/** The open branches of a salon, in a stable order. Exported with `serialiseSalon`. */
export function openBranchesOf(salonId: string) {
  return db
    .select()
    .from(branch)
    .where(and(eq(branch.salonId, salonId), isNull(branch.closedAt)))
    .orderBy(branch.id);
}

/**
 * Read the salon or 404. Used by every handler in this file that writes one, and
 * by `GET`/`PATCH /v1/platform/salons/{id}`.
 *
 * A PLAIN 404 IS RIGHT FOR BOTH CALLERS, for different reasons that happen to
 * agree: a merchant has already been through `requireSameSalon`, so by the time
 * she is here the id is her own; and a platform admin reads across salons by
 * design, so there is no tenancy fact for a 404-vs-403 distinction to leak.
 */
export async function loadSalon(id: string): Promise<typeof salon.$inferSelect> {
  const rows = await db.select().from(salon).where(eq(salon.id, id)).limit(1);
  const s = rows[0];
  if (!s) throw notFound('unknown_salon', 'No such salon.');
  return s;
}


/**
 * A branch of THIS salon, open or closed, or a 404.
 *
 * Scoped to the salon in the same predicate rather than fetched by id and
 * checked afterwards — the same rule `POST /scans` learned the hard way. A
 * branch of another tenant is `unknown_branch`, identical to one that does not
 * exist, because a distinguishable 403 would confirm the id names something
 * real somewhere else.
 */
async function loadBranch(salonId: string, id: string): Promise<typeof branch.$inferSelect> {
  const rows = await db
    .select()
    .from(branch)
    .where(and(eq(branch.id, id), eq(branch.salonId, salonId)))
    .limit(1);
  const b = rows[0];
  if (!b) throw notFound('unknown_branch', 'No such branch.');
  return b;
}

/**
 * Exported so the onboarding wizard's first branch is minted by the SAME
 * generator as every branch added afterwards. The design's own wizard names that
 * first branch after the city (`branches: [{ id: 'BR-NEW', name: x.wCity }]`),
 * and a second id scheme for the first branch of a salon would be a difference
 * nobody chose.
 */
export function branchId(): string {
  return `BR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** The two audit columns every handler in this file fills the same way. */
function clientMeta(req: FastifyRequest): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * THE SALON PATCH BODY — one translator, two gates.
 *
 * This was inline in `PATCH /salons/{id}` until `PATCH /v1/platform/salons/{id}`
 * needed the same thing. It is a function rather than a copy for the reason this
 * file already gives twice: the tier ladder acquired an unvalidated second
 * entrance exactly this way, and the console's copy would have been the one
 * nobody was watching. `editable` is the ONLY difference between the two callers
 * — the merchant set, or that set plus `city` and `ownerPhone`.
 *
 * It returns the patch and the key list rather than performing the UPDATE,
 * because the two callers write different audit rows (`merchant` vs
 * `owner_console`) against different principals, and the salon id comes from the
 * URL either way.
 */
export function buildSalonPatch(
  body: Record<string, unknown>,
  before: SalonRow,
  editable: ReadonlySet<string>,
): { patch: Record<string, unknown>; keys: string[] } {
  const keys = Object.keys(body);
  if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');

  /**
   * THE LOYALTY FIELDS ARE REFUSED FIRST, AND WITH THEIR OWN ERROR.
   *
   * They would already be refused one line down — they are no longer in
   * `MERCHANT_EDITABLE` — but as `400 not_editable`, "These fields cannot be
   * edited here: tiers." That message is the one this route's own comment warns
   * against: it "sends somebody looking for a bug in the wrong place". `tiers`
   * IS editable here, by AVO, through this very function with the console's set;
   * what changed is who may. A merchant told the field is not editable here goes
   * looking for the route where it is, finds `PUT /salons/{id}/loyalty`, and is
   * refused there too, for a reason the first refusal never gave her.
   *
   * `403 loyalty_read_only` is the same answer both doors give, which is the
   * property worth having: one withdrawn capability, one code, wherever a client
   * knocks. See `http/errors.ts § loyaltyReadOnly`.
   *
   * KEYED ON THE `editable` SET, NOT ON THE PRINCIPAL. This function takes no
   * principal — deliberately, see its header — and `editable.has('tiers')` is
   * exactly the question "is this the console's set?" asked in the vocabulary
   * the function already has. A caller cannot get the merchant refusal and the
   * console's fields at the same time, because they are the same fact.
   */
  if (!editable.has('tiers') && keys.some((k) => LOYALTY_FIELDS.has(k))) {
    throw loyaltyReadOnly();
  }

  const rejected = keys.filter((k) => !editable.has(k));
  if (rejected.length > 0) {
    /**
     * NAMED, and the message says "here" on purpose. A merchant sending `city`
     * gets told that field is not editable HERE rather than that it does not
     * exist — it does, and the console can change it. A field refused with the
     * wrong reason sends somebody looking for a bug in the wrong place.
     */
    throw badRequest('not_editable', `These fields cannot be edited here: ${rejected.join(', ')}.`);
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of keys) patch[k] = normaliseArabic(k, body[k]);

  // Refused here, before the UPDATE, so a typo is a 400 naming the tz database
  // rather than a 500 thrown out of `Intl.DateTimeFormat` inside the next
  // charge that tries to resolve a happy hour.
  if ('timezone' in body) patch.timezone = parseTimeZone(body.timezone);

  // Every remaining field whose wire type is not its column type, or whose
  // range the database states as a CHECK. See the helpers at the top.
  //
  // `brandColor` is here rather than left to `salon_brand_color_is_hex`
  // because that CHECK only asks whether the string is a hex, and #9 asks
  // whether the hex can carry white text. See services/brandColor.ts.
  if ('brandColor' in body) patch.brandColor = parseBrandColor(body.brandColor);
  if ('depositFils' in body) patch.depositFils = parseDepositFils(body.depositFils);
  if ('noShowReturnMinutes' in body) {
    patch.noShowReturnMinutes = parseNoShowReturnMinutes(body.noShowReturnMinutes);
  }
  /**
   * THE LAST UNVALIDATED JSONB DOOR ON THIS TABLE, closed.
   *
   * `businessHours` was in the editable set from the day this route existed and
   * nothing checked it, so `{ morning: ["banana", 7] }` was storable — and
   * `services/availability.ts` then calls `hhmmToMinutes` on it inside
   * `computeAvailability`, which THROWS. One bad Settings save turned every
   * availability read for that salon into a 500, on the booking screen, three
   * screens from the field that was typed wrong. Same shape as `brandColor`, same
   * reasoning as `timezone` right above. See `http/fields.ts § parseBusinessHours`.
   */
  if ('businessHours' in body) {
    patch.businessHours = parseBusinessHours(body.businessHours);
  }
  /**
   * AND `social` WAS THE OTHER ONE. Same door, same class of defect, closed the
   * same way and one release later than it should have been.
   *
   * `social` has been in `MERCHANT_EDITABLE` since this route was written and
   * nothing checked it, so the loop above handed `{"social": "banana"}` straight
   * to a jsonb column — and `visibleSocialLinks` in `@avo/types` then calls
   * `.flatMap` on whatever came back, in the WALLET, on the Help screen. Exactly
   * the `businessHours` failure one line up: one bad Settings save breaking a
   * screen three screens away from the field that was typed wrong.
   *
   * The parser is shared with `PATCH /v1/salons/{id}/social/{linkId}` rather than
   * written twice — see services/socialLinks.ts, which also records why this
   * whole-array door is kept rather than narrowed away, and what should replace it.
   */
  if ('social' in body) {
    patch.social = parseSocialLinks(body.social);
  }
  if ('modules' in body) {
    // `modules` is a wire shape, not a column. Remove it before the UPDATE or
    // Drizzle would try to set a column that does not exist.
    delete patch.modules;
    applyModules(body.modules, patch);
  }
  /**
   * The two platform-only fields. Unreachable unless the caller passed
   * `PLATFORM_EDITABLE`, because the allow-list above has already refused them —
   * but parsed here rather than in the console route, so the ONE translator owns
   * every field's shape and a future reader does not have to check two files to
   * know what `ownerPhone` accepts.
   *
   * `city` goes through `requireString` and NOT `normaliseArabic`: an empty city
   * is not a cleared translation, it is a missing fact, and
   * `salon_city_not_blank` refuses `''` at the database. `ownerPhone` goes
   * through the same `parseE164` that produced the stored value at onboarding, so
   * "+965 9912 4408" is accepted with its spaces the way a person types it.
   */
  if ('city' in body) patch.city = requireString(body.city, 'city', 120);
  if ('ownerPhone' in body) patch.ownerPhone = parseE164(body.ownerPhone);

  /**
   * THE SECOND DOOR INTO THE TIER LADDER, AND WHY IT IS VALIDATED HERE TOO.
   *
   * `tiers`, `loyaltyMode`, `stampTarget` and the stamp reward copy were in the
   * editable set since this route was written, and until this guard landed
   * nothing checked them. Every rule the publish endpoint enforces — four rungs,
   * Bronze locked at 0/0, each threshold above the one below — could be walked
   * around by sending the same fields one route over, which makes the validation
   * decorative: an invalid ladder published through the unguarded door is not a
   * smaller money bug than one published through the guarded one.
   *
   * So the loyalty fields go through the SAME validator
   * (services/loyaltyRules.ts), and the result replaces them wholesale rather
   * than being merged key by key. The validator returns a COMPLETE
   * configuration — it fills in whatever the request did not mention from the
   * current row — which is what keeps `salon_loyalty_config_complete`
   * satisfiable when a caller flips `loyaltyMode` and nothing else.
   *
   * `PUT /salons/{id}/loyalty` remains the endpoint the editor should use: it
   * returns the preview and writes the "Tier rules published" audit line. This
   * is the guard on the general-purpose door, not a second front entrance.
   */
  if (keys.some((k) => LOYALTY_FIELDS.has(k))) {
    const config = parseLoyaltyConfig(body, loyaltyConfigOf(before));
    patch.loyaltyMode = config.mode;
    patch.tiers = config.tiers;
    patch.stampTarget = config.stampTarget;
    patch.stampReward = config.stampReward;
    patch.stampRewardAr = config.stampRewardAr;
  }

  return { patch, keys };
}

/**
 * One page of `GET /salons/{id}/bookings`. The cap the route already had, kept at
 * the same number so no client's first page changes shape — what changed is that
 * `nextCursor` now tells the truth about there being a second one.
 */
const BOOKINGS_PAGE = 200;

export async function registerSalonRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requireSalonScoped(req);
    requireSameSalon(p, req.params.id);

    const s = await loadSalon(req.params.id);
    return reply.send(serialiseSalon(s, await openBranchesOf(s.id)));
  });

  /**
   * perms.loyalty — the Settings screen writes through here.
   *
   * IT USED TO SAY "the loyalty editor writes through here", AND THAT IS NO
   * LONGER TRUE. The five loyalty fields left `MERCHANT_EDITABLE` when loyalty
   * authority moved to AVO; this route now carries brand colour, deposit,
   * modules, timezone, business hours, social and the Arabic name — settings,
   * not rules. `perms.loyalty` survives as the gate on that screen, which is a
   * narrower meaning than the name suggests. routes/loyalty.ts and the
   * `perms.settings` escalation below both record it.
   */
  app.patch<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const before = await loadSalon(req.params.id);
    const { patch, keys } = buildSalonPatch(
      (req.body ?? {}) as Record<string, unknown>,
      before,
      MERCHANT_EDITABLE,
    );

    /**
     * SHE MAY CHOOSE A CHANNEL; SHE MAY NOT CHOOSE SILENCE.
     * (DECISIONS.md #88, migration 0047)
     *
     * `salon_receipt_channel_floor` is the control — both-off does not commit —
     * but a raw check violation surfaces as a 500, and non-negotiable #7's
     * "the UI hiding a button is a courtesy, not a control" cuts the other way
     * too: the API has to be the one that says no, in words a client can render.
     *
     * Computed from the PATCH MERGED OVER THE CURRENT ROW rather than from the
     * body, because a request that sends only `whatsappEnabled: false` is
     * exactly the one that can turn the last channel off.
     *
     * A receipt is "a record-keeping obligation, not marketing"
     * (design/README.md § Known gaps 7), which is why this is not a preference
     * she can express.
     */
    const nextWhatsapp = patch.whatsappEnabled ?? before.whatsappEnabled;
    const nextEmail = patch.emailEnabled ?? before.emailEnabled;
    if (!nextWhatsapp && !nextEmail) {
      throw conflict(
        'receipt_channels_required',
        'A receipt has to reach the customer somehow. Keep WhatsApp or email switched on.',
      );
    }

    const [after] = await db
      .update(salon)
      .set(patch)
      .where(eq(salon.id, req.params.id))
      .returning();
    if (!after) throw notFound('unknown_salon', 'No such salon.');

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Salon settings changed',
      detail: `Changed: ${keys.join(', ')}`,
      source: 'merchant',
      subjectType: 'salon',
      subjectId: req.params.id,
      metadata: { changed: keys },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    // The SAME shape `GET` answers. See `serialiseSalon`.
    return reply.send(serialiseSalon(after, await openBranchesOf(after.id)));
  });

  /**
   * ======================================================================
   * PATCH /v1/salons/{id}/social/{linkId}   { handle?, on? }
   * ======================================================================
   * api-contract.md names this endpoint twice — § SocialLink and § Operations,
   * "Merchant | Social links" — and it did not exist. The only way to change a
   * handle was to send the whole `social` array through `PATCH /salons/{id}`
   * above: a different endpoint, a different granularity and a different
   * permission from the one specified. Aftab's call (DECISIONS.md #17) is to build
   * what the contract says, because the contract is the specification and the
   * array field was the improvisation.
   *
   * THE PRECEDENT IS THE PRODUCT CATALOGUE, twenty lines further down this file,
   * and its comment is the argument here verbatim: a bulk write makes "one
   * keystroke in one row a rewrite of every product the salon sells, so two
   * managers editing different rows would silently overwrite each other". Four
   * social channels instead of forty products; identical failure. The design's own
   * reference implementation already works per link —
   * `API.setSocial(so.id, { handle })` on each keystroke,
   * `API.setSocial(so.id, { on })` on each toggle — so this is the shape the
   * screen was drawn against.
   *
   * ---------------------------------------------------------------------
   * THE PERMISSION IS `perms.loyalty`, AND THAT NAME IS WRONG. REPORTED.
   * ---------------------------------------------------------------------
   * Social links are a SETTINGS concern — `AVO Merchant Dashboard.dc.html` draws
   * them in Settings, between the customer-app preview and Optional modules — and
   * every other write on that screen is already gated on `perms.loyalty`:
   * `PATCH /salons/{id}` and the three branch routes below, which carry the same
   * note. The nine permissions in api-contract.md § StaffUser have no "settings"
   * among them.
   *
   * So the choice is between the gate the rest of the screen uses and inventing a
   * tenth permission, and inventing one is a contract change this lane may not
   * make. Gating on anything WEAKER would be the real defect: a staff member who
   * cannot change the deposit would be able to repoint the salon's public
   * Instagram, which is the salon's identity in every customer's app.
   *
   * `perms.marketing` was considered and rejected. It gates campaigns — messages
   * AVO sends to customers on a merchant's behalf, under caps and quiet hours and
   * platform approval (non-negotiable #8) — and a handle in a Settings form shares
   * none of that machinery. Putting social links there would make `marketing` mean
   * two unrelated things and would hand campaign authority to whoever is trusted to
   * type an Instagram name.
   *
   * ESCALATED TO TRUNK, not decided here: the honest name for this gate is
   * `perms.settings`, and adding it is a four-way break — `PERMISSION_NAMES`,
   * `PERM_COLUMN`, the `staff_user` columns, the Accounts → Team chips and the
   * permission census all move together. Until that decision is made, `loyalty` is
   * the gate the screen already has.
   * ---------------------------------------------------------------------
   *
   * THE WHOLE-ARRAY FIELD STILL EXISTS, deliberately, and is now validated for the
   * first time. services/socialLinks.ts carries that decision in full: `social`
   * lives in `MERCHANT_EDITABLE`, `PLATFORM_EDITABLE` is that set plus two fields,
   * and a separate session is building the console salon editor in
   * `apps/dashboard/` right now — so removing the field would delete a capability
   * out from under another lane's in-flight work. The recommendation to trunk is
   * that it become console-only once the dashboard uses this endpoint.
   */
  app.patch<{ Params: { id: string; linkId: string } }>(
    '/v1/salons/:id/social/:linkId',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      /**
       * An unknown channel is a 400 naming the four, not a 404. A 404 would read
       * as "this salon has no Instagram", which is a true-sounding answer to a
       * question that was never asked — the id space is closed by the contract, so
       * a value outside it is a malformed request rather than a missing thing.
       */
      const linkId = req.params.linkId;
      if (!isSocialId(linkId)) {
        throw badRequest(
          'unknown_social_link',
          `Unknown social channel "${linkId}". AVO supports ${SOCIAL_IDS.join(', ')}.`,
        );
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(body).filter((k) => k !== 'handle' && k !== 'on');
      if (unknown.length > 0) {
        /**
         * `label` is the field somebody will try, and it is refused BY NAME here
         * rather than ignored. It is derived from the id — see
         * services/socialLinks.ts § SOCIAL_LABELS — because it renders under the
         * icon in every customer's app and a merchant-settable string there is
         * arbitrary copy in the wallet with no review path.
         */
        throw badRequest(
          'invalid_field',
          `Not editable: ${unknown.join(', ')}. A social link has a handle and an on switch.`,
        );
      }

      const patch: { handle?: string; on?: boolean } = {};
      if ('handle' in body) patch.handle = parseSocialHandle(linkId, body.handle);
      if ('on' in body) patch.on = parseSocialOn(body.on);
      if (Object.keys(patch).length === 0) {
        throw badRequest('invalid_request', 'Send a handle, an on switch, or both.');
      }

      /**
       * ONE TRANSACTION WITH THE SALON ROW LOCKED, and that lock is the endpoint.
       *
       * Without it this is a read-modify-write of a jsonb array, which is exactly
       * the overwrite the per-link granularity exists to prevent — performed by
       * the thing that was supposed to prevent it. Two managers saving Instagram
       * and WhatsApp in the same instant would both read the array as it was, and
       * whichever committed second would put the other's channel back.
       *
       * `FOR UPDATE` serialises them, so the second reads the first's result and
       * both edits survive. It is the same mechanism `performCharge` uses on the
       * member row for the same class of reason: the value this transaction reads
       * is the value it writes.
       */
      const { link, after } = await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ social: salon.social })
          .from(salon)
          .where(eq(salon.id, req.params.id))
          .for('update')
          .limit(1);
        if (!before) throw notFound('unknown_salon', 'No such salon.');

        const applied = applySocialPatch(before.social, linkId, patch);

        const [row] = await tx
          .update(salon)
          .set({ social: applied.links, updatedAt: new Date() })
          .where(eq(salon.id, req.params.id))
          .returning({ social: salon.social });
        if (!row) throw notFound('unknown_salon', 'No such salon.');

        await writeAudit(tx, p, {
          salonId: p.salonId,
          // `rules`, not `money`. Nothing moved; what changed is how the salon
          // presents itself in the customer app. The same kind the product and
          // branch writes on this screen use.
          kind: 'rules',
          action: 'Social link changed',
          /**
           * WHAT IT IS NOW, spelled out, the way "Product edited" spells out the
           * new price. A merchant reading this later is asking "who repointed our
           * Instagram and to what", and "changed" does not answer it. An empty
           * handle is named as cleared rather than rendered as a blank.
           */
          detail:
            `${applied.link.label} · ` +
            (applied.link.handle === '' ? 'handle cleared' : applied.link.handle) +
            ` · ${applied.link.on ? 'shown' : 'hidden'}`,
          source: 'merchant',
          subjectType: 'social_link',
          subjectId: linkId,
          metadata: {
            changed: Object.keys(patch),
            handle: applied.link.handle,
            on: applied.link.on,
          },
          ...clientMeta(req),
        });

        return { link: applied.link, after: row.social };
      });

      /**
       * The one link, not the salon — the same shape `PATCH .../products/{pid}`
       * answers with, and what a form that saves as you type needs back.
       *
       * `url` IS DERIVED AND SENT WITH IT, from the shared `socialUrl` in
       * `@avo/types`, so the merchant screen can show where the icon now points
       * without reimplementing the four rules. It is derived on every read and
       * stored nowhere — api-contract.md: "Never persist a URL: a salon that edits
       * its handle would leave the icon pointing at a dead profile." `null` when
       * the handle is empty, which is a fact the form should render rather than
       * hide.
       *
       * `links` is the whole array as it now stands, because the client that just
       * wrote one link is holding a copy of all four and a colleague may have moved
       * another one a second ago. Returning it costs nothing — it is the row that
       * was just written — and it is what stops the save-as-you-type screen
       * drifting from the server.
       */
      return reply.send({
        ...link,
        url: socialUrl(link.id, link.handle),
        links: after,
      });
    },
  );

  // ========================================================================
  // BRANCHES — the write path phase 4 was missing.
  //
  // THE PERMISSION IS `loyalty`, and it is worth saying why rather than
  // leaving it to look arbitrary. Branches are a Settings concern, and
  // `PATCH /salons/{id}` — the Settings write these three sit beside — is
  // already gated on `perms.loyalty`. The nine permissions in
  // api-contract.md § StaffUser have no "settings" among them, so a new gate
  // would have to be invented, and inventing a tenth permission is a contract
  // change this lane may not make. Gating the branch routes on anything
  // WEAKER than the screen they live on would be the real defect: it would let
  // a staff member who cannot change the deposit restructure the salon.
  // Reported to trunk as a contract observation.
  // ========================================================================

  /** perms.loyalty. A salon opens a second location. */
  app.post<{ Params: { id: string } }>('/salons/:id/branches', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);
    await loadSalon(req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rejected = Object.keys(body).filter((k) => k !== 'name' && k !== 'nameAr');
    if (rejected.length > 0) {
      throw badRequest(
        'not_editable',
        `These fields cannot be set on a branch: ${rejected.join(', ')}.`,
      );
    }

    const name = requireString(body.name, 'name', 120);
    const nameAr = normaliseArabic('nameAr', body.nameAr) as string | null;

    // `branch_salon_name_uq` spans CLOSED branches too, so this catches the
    // re-opening case as well as the duplicate one. Asked here so the merchant
    // gets a sentence naming the alternative, rather than a 23505 as a 500.
    const clash = await db
      .select({ id: branch.id, closedAt: branch.closedAt })
      .from(branch)
      .where(and(eq(branch.salonId, req.params.id), eq(branch.name, name)))
      .limit(1);
    if (clash[0]) {
      throw conflict(
        'branch_name_taken',
        clash[0].closedAt
          ? `This salon already has a branch called "${name}" that is closed. Re-open that one instead, so its history stays attached to it.`
          : `This salon already has a branch called "${name}".`,
      );
    }

    const id = branchId();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(branch)
        .values({ id, salonId: req.params.id, name, nameAr })
        .returning();

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Branch opened',
        detail: name,
        source: 'merchant',
        subjectType: 'branch',
        subjectId: id,
        metadata: { name, nameAr },
        ...clientMeta(req),
      });
      return inserted;
    });

    if (!row) throw conflict('branch_not_created', 'That branch could not be created.');
    return reply.code(201).send(serialiseBranch(row));
  });

  /** perms.loyalty. Rename a branch, in either language. */
  app.patch<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(body);
      if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');
      const rejected = keys.filter((k) => k !== 'name' && k !== 'nameAr');
      if (rejected.length > 0) {
        throw badRequest(
          'not_editable',
          `These fields cannot be edited on a branch: ${rejected.join(', ')}.`,
        );
      }

      const current = await loadBranch(req.params.id, req.params.bid);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if ('name' in body) patch.name = requireString(body.name, 'name', 120);
      if ('nameAr' in body) patch.nameAr = normaliseArabic('nameAr', body.nameAr);

      if (typeof patch.name === 'string' && patch.name !== current.name) {
        const clash = await db
          .select({ id: branch.id })
          .from(branch)
          .where(and(eq(branch.salonId, req.params.id), eq(branch.name, patch.name)))
          .limit(1);
        if (clash[0]) {
          throw conflict(
            'branch_name_taken',
            `This salon already has a branch called "${patch.name as string}".`,
          );
        }
      }

      const [row] = await db.transaction(async (tx) => {
        const updated = await tx
          .update(branch)
          .set(patch)
          .where(eq(branch.id, current.id))
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Branch renamed',
          detail: `${current.name} → ${(patch.name as string | undefined) ?? current.name}`,
          source: 'merchant',
          subjectType: 'branch',
          subjectId: current.id,
          metadata: { before: serialiseBranch(current), changed: keys },
          ...clientMeta(req),
        });
        return updated;
      });

      if (!row) throw notFound('unknown_branch', 'No such branch.');
      return reply.send(serialiseBranch(row));
    },
  );

  /**
   * perms.loyalty. CLOSE a branch. It is not deleted, and this is the cascade
   * the API owns rather than leaving to a foreign key.
   *
   * WHY A CLOSE. `transaction.branch_id` and `booking.branch_id` are both NOT
   * NULL and `ON DELETE restrict`. A real DELETE of a branch that has ever
   * taken money is refused by the database and arrives at the merchant as a
   * 500 — and the refusal is correct, because per-branch revenue, a customer's
   * receipt and an appointment history all name the branch. Same rule the
   * happy-hour delete already states: the receipts refer to it, switch it off.
   *
   * THE THREE THINGS THAT REFERENCE A BRANCH, AND WHAT HAPPENS TO EACH:
   *
   * 1. STAFF (`staff_user.branch_access_ids`). The id is REMOVED from every
   *    staff row in the salon, in this transaction, and each affected member is
   *    named in the audit row. A staff member scoped only to this branch is
   *    left with an EMPTY access list — she is not promoted to `all`.
   *    Widening authority as a side effect of closing a location is exactly
   *    the privilege escalation the permission model exists to prevent, and
   *    "revoking charges takes void with it" is the same instinct: when a
   *    change makes authority ambiguous, the safe direction is less.
   *    The owner re-scopes her from Accounts → Team, and the audit row tells
   *    her who needs it.
   *
   * 2. BOOKINGS. Left exactly as they are, and this is deliberate rather than
   *    lazy. A booking's `branch_id` comes from `resolveBranch`, which for a
   *    multi-branch salon is an ATTRIBUTION and is flagged `branch_assumed` as
   *    such — services/branch.ts is explicit that such a value must not drive
   *    a decision. Refusing to close a location because of appointments whose
   *    branch was GUESSED would be a refusal built on a number the codebase
   *    says is not knowledge. The count is reported and audited so the
   *    merchant knows what she still has to deal with, and each booking runs
   *    to its own end state; the deposit-return path is untouched by this and
   *    a no-show at a closed branch still returns the customer's money.
   *
   * 3. TRANSACTIONS. Untouched, still pointing at a branch that still exists
   *    and still has a name to render. That is the entire point of a close.
   *
   * The LAST OPEN BRANCH cannot be closed. `resolveBranch` refuses a salon with
   * none, so the next charge, top-up and booking would all fail with
   * `no_branch` — a total money outage produced by a settings change. Refused
   * here with a sentence instead of discovered at the counter.
   */
  // ------------------------------------------- the closure preview (read) ----
  /**
   * WHAT CLOSING THIS BRANCH WOULD DO — on `perms.loyalty`, the same permission as
   * the close itself.
   *
   * THE PERMISSION IS THE WHOLE POINT. The close returns `staffRescoped`,
   * `staffLeftWithNoBranch` and `depositHeldBookings`, but computed them inside the
   * transaction that performs it — so the facts a merchant needs BEFORE deciding
   * arrived only afterwards. With no preview, lane C had to derive them client-side
   * from the roster and the appointment list, and those reads need `perms.team` and
   * `perms.appointments`: a `loyalty`-only account could close a branch it was not
   * allowed to be warned about. Lane C degraded the warning to categories without
   * counts rather than invent numbers, which was right, and is a mitigation.
   *
   * Gating this on `loyalty` means no second permission stands between a destructive
   * button and its own consequences. Whoever may close a branch may be told what
   * closing it does.
   *
   * A SEPARATE READ rather than `?dryRun` on the DELETE: it is cacheable, it cannot
   * be fired by accident, and a destructive verb that sometimes does nothing is a
   * request whose effect depends on a query parameter nobody sees in a log.
   *
   * `closable` IS INCLUDED because the close can be refused outright — a salon with
   * no open branch cannot take a payment, a top-up or a booking, so the last one is
   * protected. A merchant should learn that here rather than from an error after she
   * has decided.
   *
   * The numbers come from the same `branchClosureImpact` the close uses. Field names
   * match the close's response exactly, so the preview and the outcome are
   * comparable rather than merely similar.
   */
  app.get<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid/closure-preview',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const current = await loadBranch(req.params.id, req.params.bid);
      const open = await openBranchesOf(req.params.id);
      const impact = await branchClosureImpact(db, req.params.id, current.id);

      const alreadyClosed = current.closedAt !== null;
      const lastOpen = !alreadyClosed && open.length <= 1;

      return reply.send({
        ...serialiseBranch(current),
        /** Whether the DELETE would go through, and why not when it would not. */
        closable: !alreadyClosed && !lastOpen,
        blockedReason: alreadyClosed
          ? 'already_closed'
          : lastOpen
            ? 'last_open_branch'
            : null,
        openBranchCount: open.length,
        // The same three the close reports, in the same shape — names, not ids,
        // because this is what a merchant reads on a confirmation sheet.
        staffRescoped: impact.staffRescoped.map((x) => x.name),
        staffLeftWithNoBranch: impact.staffRescoped
          .filter((x) => x.remaining === 0)
          .map((x) => x.name),
        depositHeldBookings: impact.depositHeldBookings,
        depositHeldBookingsBranchAssumed: impact.depositHeldBookingsBranchAssumed,
        /**
         * The tills the close would UNENROL (DECISIONS.md #91). Labels, because
         * this is a confirmation sheet. Before this field the merchant could
         * only learn it by charging from the till and getting a 404.
         */
        tillsUnenrolled: impact.tillsUnenrolled.map((t) => t.label),
      });
    },
  );

  app.delete<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const current = await loadBranch(req.params.id, req.params.bid);

      // Idempotent: closing a closed branch is not an error, and must not write
      // a second audit row claiming it happened twice.
      if (current.closedAt) return reply.send(serialiseBranch(current));

      const open = await openBranchesOf(req.params.id);
      if (open.length <= 1) {
        throw conflict(
          'last_open_branch',
          'This is the salon\'s only open branch. A salon with no open branch cannot take a payment, a top-up or a booking — open the new location first, then close this one.',
        );
      }

      /**
       * Through the SHARED calculation, so the preview and the close cannot
       * disagree about money already taken from customers. This used to be its own
       * inline count; `services/branchClosure.ts` explains why one implementation
       * matters here specifically.
       */
      const impact = await branchClosureImpact(db, req.params.id, current.id);
      const heldCount = impact.depositHeldBookings;
      const heldAssumed = impact.depositHeldBookingsBranchAssumed;

      const closedAt = new Date();
      const { row, rescoped, stranded, tillsRevoked } = await db.transaction(async (tx) => {
        const updated = await tx
          .update(branch)
          .set({ closedAt, updatedAt: closedAt })
          .where(eq(branch.id, current.id))
          .returning();

        // Every staff row in the salon that names this branch. `array_remove`
        // does it in one statement so there is no read-modify-write to race,
        // and `RETURNING` names who was affected for the audit row.
        // `array_remove` in ONE statement, so there is no read-modify-write for
        // a concurrent permission change to race, and `RETURNING` names who was
        // affected without a second query that could see a different world.
        //
        // Through the query builder rather than a raw `sql` template: the
        // template binds `closedAt` as a Date straight to postgres.js, which
        // refuses it, while the builder maps it through the column's own
        // `timestamptz` codec.
        const affected = await tx
          .update(staffUser)
          .set({
            branchAccessIds: sql`array_remove(${staffUser.branchAccessIds}, ${current.id})`,
            updatedAt: closedAt,
          })
          .where(
            and(
              eq(staffUser.salonId, req.params.id),
              sql`${current.id} = ANY(${staffUser.branchAccessIds})`,
            ),
          )
          .returning({
            id: staffUser.id,
            name: staffUser.name,
            branchAccessIds: staffUser.branchAccessIds,
          });

        /**
         * SORTED BY ID, TO MATCH THE PREVIEW — the one thing about these two
         * lists that could differ.
         *
         * WHAT WAS CHECKED AND FOUND NOT TO BE A DEFECT: the SET. It was put to
         * this lane that "a merchant may confirm one list and have another acted
         * on", and she cannot. `branchClosureImpact` runs the SAME predicate as
         * the UPDATE above — `salon_id = … AND :branchId = ANY(branch_access_ids)`
         * — so membership is identical by construction, and `branch_access_all`
         * staff are unmatchable by both for the reason below. Nobody is re-scoped
         * who was not previewed.
         *
         * WHAT DID DIFFER IS ORDER, AND IT IS OBSERVABLE. The preview ends
         * `.orderBy(staffUser.id)`; `UPDATE … RETURNING` has no ORDER BY in
         * Postgres and hands rows back in whatever order it touched them. That
         * order reaches the merchant twice — the audit `detail` joins the stranded
         * NAMES into a sentence, and this handler's own response returns
         * `staffRescoped` and `staffLeftWithNoBranch` as name arrays that the
         * Settings screen renders beside the list she just confirmed. So two
         * lists of the same people in two orders, which reads as a discrepancy
         * for a merchant checking one against the other.
         *
         * Cosmetic, then, not a correctness bug — and one line to remove, which
         * is a better trade than a comment explaining why the two disagree.
         * Sorted here rather than in the SQL because RETURNING cannot be ordered.
         */
        affected.sort((a, b) => a.id.localeCompare(b.id));

        // `branch_access_all` staff are untouched by the UPDATE above — their id
        // list is empty by the `staff_user_branch_access_exclusive` CHECK, so
        // `= ANY(…)` never matches them. An empty list here can therefore only
        // mean a member who was scoped to branches and now has none.
        const strandedRows = affected.filter((s) => s.branchAccessIds.length === 0);

        /**
         * THE TILLS, CASCADED — revoked, not stranded.  (DECISIONS.md #91)
         *
         * A till enrolled here becomes a DEAD COUNTER the moment this UPDATE
         * commits: `resolveBranch` requires `closed_at IS NULL` on a supplied
         * branch and throws `unknown_branch` otherwise, so the next charge from
         * that device is refused outright. `routes/devices.ts` already refuses to
         * ENROL into a closed branch for exactly that reason; this is the same
         * guard on the other door.
         *
         * WHY CASCADE RATHER THAN REFUSE THE CLOSE, which was the safest of the
         * three options: because this file's own precedent is cascade-and-report.
         * Staff scoped to this branch are `array_remove`d rather than blocking
         * the close, and appointments still holding a deposit are reported rather
         * than blocking it. A close is refused for exactly one reason — it would
         * leave the salon with no open branch — and inventing a second class of
         * blocker would mean a merchant mid-day cannot close a location until she
         * has hunted down an iPad.
         *
         * WHAT IT COSTS, AND WHERE IT IS VISIBLE: those tills keep charging and
         * silently stop earning their branch's boost, which is decision 82's
         * original defect arriving through the back door. So it is named in three
         * places rather than none — `closure-preview` before she confirms, the
         * DELETE's own response, and the audit metadata below — and the revoked
         * rows persist with `revoked_at` so the history survives.
         *
         * `revoked_at IS NULL` in the predicate, so a re-close cannot re-revoke a
         * row and the count cannot double-report.
         */
        const tillsRevoked = await tx
          .update(deviceEnrolment)
          .set({ revokedAt: closedAt, revokedByStaffId: p.id, updatedAt: closedAt })
          .where(
            and(
              eq(deviceEnrolment.salonId, req.params.id),
              eq(deviceEnrolment.branchId, current.id),
              isNull(deviceEnrolment.revokedAt),
            ),
          )
          .returning({ deviceId: deviceEnrolment.deviceId, label: deviceEnrolment.label });

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Branch closed',
          detail:
            `${current.name} closed` +
            (affected.length ? ` · ${affected.length} staff re-scoped` : '') +
            (strandedRows.length
              ? ` · ${strandedRows.map((s) => s.name).join(', ')} ${strandedRows.length === 1 ? 'now has' : 'now have'} no branch access`
              : '') +
            (heldCount ? ` · ${heldCount} appointment(s) still hold a deposit here` : '') +
            (tillsRevoked.length
              ? ` · ${tillsRevoked.length} till(s) unenrolled: ${tillsRevoked.map((t) => t.label).join(', ')}`
              : ''),
          source: 'merchant',
          subjectType: 'branch',
          subjectId: current.id,
          metadata: {
            branch: serialiseBranch(current),
            staffRescoped: affected.map((s) => ({
              id: s.id,
              name: s.name,
              remaining: s.branchAccessIds.length,
            })),
            staffLeftWithNoBranch: strandedRows.map((s) => s.id),
            depositHeldBookings: heldCount,
            depositHeldBookingsBranchAssumed: heldAssumed,
            tillsUnenrolled: tillsRevoked,
          },
          ...clientMeta(req),
        });

        return { row: updated[0], rescoped: affected, stranded: strandedRows, tillsRevoked };
      });

      if (!row) throw notFound('unknown_branch', 'No such branch.');

      /**
       * 200 with a body, not 204. A close is an UPDATE — the merchant's screen
       * wants the row back to re-render it as closed, and `closedAt` is the
       * fact she just created. A 204 would make the client re-read to find out
       * what its own request did, which is the defect `PATCH /salons/{id}` had.
       */
      return reply.send({
        ...serialiseBranch(row),
        closedAt: row.closedAt?.toISOString() ?? null,
        /**
         * What the close actually touched — read from the UPDATE's own
         * RETURNING, not re-queried afterwards, so it describes this close and
         * not the salon's general state. The Settings screen says it out loud
         * rather than leaving the merchant to find it in the audit log: both
         * are consequences she cannot see from the branch list she was looking
         * at, and `staffLeftWithNoBranch` is the one that needs her attention.
         */
        staffRescoped: rescoped.map((s) => s.name),
        staffLeftWithNoBranch: stranded.map((s) => s.name),
        /**
         * The tills this close unenrolled, from the cascade's own RETURNING —
         * the same shape and the same field name the preview serves, so the
         * confirmation and the outcome are comparable rather than similar.
         */
        tillsUnenrolled: tillsRevoked.map((t) => t.label),
        depositHeldBookings: heldCount,
        /**
         * How many of those had their branch INFERRED rather than recorded. Lane C's
         * point, and it is about money: an artist has no branch column, so a warning
         * about deposits already taken must not read as a fact where part of it is a
         * guess. Reported by the preview and by the close, identically.
         */
        depositHeldBookingsBranchAssumed: heldAssumed,
      });
    },
  );

  /**
   * perms.dashboard. Overview's four stat tiles, computed rather than stubbed.
   *
   * Every definition — what "active" counts, what "today" means, why a repeat
   * visit is a charge and not a transaction — lives in services/metrics.ts next
   * to the query that implements it. A metric's failure mode is not a crash, it
   * is a merchant deciding on a number that means something other than what she
   * thinks, so the definitions sit where they cannot drift from the SQL.
   */
  app.get<{ Params: { id: string }; Querystring: { period?: string; branch?: unknown } }>(
    '/salons/:id/metrics',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      /**
       * `?period=` NOW TAKES A CALENDAR RANGE TOO - `services/period.ts`. `30d`
       * behaves exactly as it did; `2026-03-01_2026-03-31` measures the salon's
       * own March.
       *
       * IT MOVES FIVE OF THE SEVEN FIGURES, NOT ALL SEVEN. `loadedTodayFils`,
       * `knetSharePercent`, `upcomingAppointments` and `nextAppointmentAt` are
       * TODAY figures - the design labels them "Loaded today" and "Upcoming
       * today" - and today does not move because a merchant selected March.
       * `services/metrics.ts` § the day states it next to the bounds.
       *
       * `?compare=` IS DELIBERATELY NOT ACCEPTED HERE. `activeMembersDelta`
       * already IS this endpoint's comparison, and it is a different statistic:
       * the same window ended a week earlier, which for `30d` overlaps itself by
       * 23 days on purpose. A second, non-overlapping comparison beside it would
       * be two answers to one question in one payload - the failure
       * `services/metrics.ts`'s header exists to prevent. Unknown query
       * parameters are dropped by Fastify, so `?compare=` here is inert rather
       * than refused; that, and the wider hole it belongs to, is reported to
       * trunk rather than closed in this slice.
       */
      const period = parsePeriod(req.query?.period);

      const rows = await db
        .select({ id: salon.id, timezone: salon.timezone })
        .from(salon)
        .where(eq(salon.id, req.params.id))
        .limit(1);
      const s = rows[0];
      if (!s) throw notFound('unknown_salon', 'No such salon.');

      /**
       * `?branch=` — THE SAME PARAMETER REPORTS TAKES, THROUGH THE SAME RESOLVER.
       *
       * Absent, empty or `all` is every branch and is exactly what this route
       * returned before the parameter existed. Not a string is 400
       * `invalid_branch`; a branch that does not exist OR belongs to another
       * salon is 404 `unknown_branch`, indistinguishable from each other on
       * purpose — `services/branchFilter.ts` carries that argument.
       *
       * AFTER `requireSameSalon`, not before. The tenancy assertion on the PATH
       * has to land first, or a caller who is not this salon's staff would learn
       * from a 404-vs-200 whether a branch id exists here — the permission check
       * turned into an oracle by an input validated too early. `reports.ts` §
       * build orders the same three calls the same way, and says why.
       *
       * The RESOLVED branch is handed to `computeMetrics`, never the raw string:
       * the salon-scoping in that lookup is the load-bearing half of this
       * parameter, and a service that took a string would be a second place to
       * forget it.
       */
      const br = await resolveBranchFilter(db, s.id, req.query?.branch);

      // The salon's zone, not the process zone: "loaded today" has to roll over
      // at the salon's midnight, or the last three hours of every evening's
      // takings land on yesterday's tile. See services/metrics.ts.
      return reply.send(await computeMetrics(db, s, period, new Date(), br));
    },
  );

  /**
   * ===================================================================
   * THE SHOP CATALOG. `perms.shop` for staff, open to the salon's own members.
   * ===================================================================
   *
   * This route returned a hardcoded `{ items: [] }` so that the ninth permission
   * had a real server-side gate rather than an unguarded 404 that looks like a
   * gate and is not — the same scaffolding `/salons/{id}/bookings` was built with.
   * It now returns actual products, and the writes below are the Shop editor the
   * dashboard draws.
   *
   * WHO MAY READ IT, AND WHY THAT IS TWO ANSWERS
   * -------------------------------------------
   * A MEMBER of this salon may. The wallet has a Shop tab, and a customer cannot
   * be sold a catalog she is not allowed to fetch. `GET /salons/{id}/services`
   * reached the same place by the same route — it is `requirePrincipal`, because
   * the Book flow needs it — and this is the shop's version of that.
   *
   * STAFF STILL NEED `perms.shop`, on the dashboard surface. For a staff member
   * this IS the Shop section, which is exactly what that permission names, and
   * the gate is the one lane D's authority and permissions suites assert on. So
   * the refusal a staff member without it gets is unchanged, byte for byte, and a
   * scanner PIN still cannot reach it at all.
   *
   * The alternative — one gate for everybody — fails whichever way it is set: keep
   * `requireDashboardPerm` and the customer's Shop tab 403s; relax it to
   * `requirePrincipal` and a permission the dashboard shows as a chip stops
   * meaning anything server-side. Two callers with different rights are two
   * checks.
   *
   * ONLY ACTIVE PRODUCTS, TO BOTH. A retired product cannot be ordered —
   * services/order.ts prices from these rows — so offering one would build a cart
   * the checkout then refuses. The merchant's editor lists what she can sell;
   * what she retired is gone from it, which is what the ✕ in the design means.
   *
   * EXACTLY `ProductSchema`'S FOUR FIELDS, and `active` is not among them. Zod
   * strips an undeclared key, so a fifth field would be one the contract silently
   * deletes in transit — the trap STATUS.md names. `ServiceSchema` declares
   * `active` and so the services route emits it; this one must not.
   */
  const productReadGate = (req: FastifyRequest, salonId: string) => {
    const p = requireSalonScoped(req);
    // A member reads her own salon's shopfront; a staff member reads the Shop
    // section and needs the permission for it. Either way, only her own salon.
    if (p.kind !== 'member') requireDashboardPerm(req, 'shop');
    requireSameSalon(p, salonId);
    return p;
  };

  app.get<{ Params: { id: string } }>('/salons/:id/products', async (req, reply) => {
    const p = productReadGate(req, req.params.id);

    /**
     * AUTHORITY FIRST, THEN THE MODULE. An anonymous or cross-salon caller must
     * not learn whether this salon sells products — `reports.ts` § `build` makes
     * the same ordering argument, and the module flag is a business fact about a
     * tenant. Only `module_shop` is selected: the row is read to answer one
     * question and `serialiseSalon`'s full shape is not needed here.
     */
    const [s] = await db
      .select({ moduleShop: salon.moduleShop })
      .from(salon)
      .where(eq(salon.id, req.params.id))
      .limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');
    assertShopReadable(p.kind, s);

    const rows = await db
      .select({
        id: product.id,
        salonId: product.salonId,
        name: product.name,
        priceFils: product.priceFils,
      })
      .from(product)
      .where(and(eq(product.salonId, req.params.id), eq(product.active, true)))
      .orderBy(product.id);

    /**
     * `image` — the fifth field, and it is a CONTRACT ADDITION THAT HAS NOT
     * LANDED YET.
     *
     * `ProductSchema` in `packages/types` declares four fields and Zod STRIPS an
     * undeclared key, so a client validating this response today silently drops
     * `image` rather than failing. That is the safe direction — additive both
     * ways — and it is precisely why the dashboard and wallet lanes must not be
     * dispatched against this until trunk lands `ImageRefSchema` and the field.
     * The header of db/schema/product.ts records the same trap for `active`.
     *
     * ONE QUERY FOR THE PAGE, not one per row. See services/imageAttachment.ts
     * § primaryImagesFor — a forty-product shop must not be forty-one round
     * trips.
     */
    const images = await primaryImagesFor(
      db,
      req.params.id,
      'product',
      rows.map((r) => r.id),
    );
    return reply.send({
      items: rows.map((r) => ({ ...r, image: images.get(r.id) ?? null })),
      nextCursor: null,
    });
  });

  /**
   * The Shop editor's three writes. `perms.shop`, dashboard surface, audit row
   * each.
   *
   * NOT IN api-contract.md, WHICH DECLARES ONLY THE READ. The design specifies
   * them in detail — `AVO Merchant Dashboard.dc.html` § SHOP draws "+ Add
   * product", an inline name field, an inline price field with a KD suffix, a ✕
   * per row, and the line "changes save as you type" — so the catalog has to be
   * writable by something. Built to the design and REPORTED as a contract
   * addition, which is how `POST /bookings/{id}/reschedule` was handled for the
   * same reason.
   *
   * "SAVES AS YOU TYPE" IS A PATCH PER FIELD, NOT A BULK PUT of the whole
   * catalog. A PUT would make one keystroke in one row a rewrite of every product
   * the salon sells, so two managers editing different rows would silently
   * overwrite each other — and the loser's product would come back at the old
   * price with nothing recording that it had moved. The tier ladder is a single
   * jsonb document for the opposite reason (a publish must not half-apply); a
   * catalog is rows, and rows are what independent edits want.
   *
   * PRICES ARE INTEGER FILS ON THE WIRE. The design's input reads `0.000` with a
   * KD suffix because that is the display boundary — non-negotiable #1 puts the
   * conversion in the client, and `parseAmountFils` refuses `8.5` here with a 400
   * naming the mistake rather than a 500 from `fils()`.
   */
  app.post<{ Params: { id: string } }>('/salons/:id/products', async (req, reply) => {
    const p = requireDashboardPerm(req, 'shop');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = requireString(body.name, 'name', 200);
    const priceFils = parseAmountFils(body.priceFils, 'priceFils');

    /**
     * The id is minted here, never taken from the body. A client-chosen primary
     * key is a client that can collide with another salon's row, and `product.id`
     * is global — `PR-` plus six base36 characters, the shape `happyHourId()`
     * uses. A collision raises a unique violation and the merchant is told to try
     * again rather than being handed somebody else's product.
     */
    const id = `PR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const now = new Date();

    const [row] = await db
      .insert(product)
      .values({ id, salonId: p.salonId, name, priceFils, createdAt: now, updatedAt: now })
      .returning({
        id: product.id,
        salonId: product.salonId,
        name: product.name,
        priceFils: product.priceFils,
      });
    if (!row) throw conflict('product_not_created', 'That product could not be saved. Try again.');

    await writeAudit(db, p, {
      salonId: p.salonId,
      // `rules`, not `money`. Nothing moved; what changed is what the salon
      // offers and at what price. The dashboard's audit filter draws the same
      // distinction — "rule change" sits beside "charge" and "void".
      kind: 'rules',
      action: 'Product added',
      detail: `${name} · ${(priceFils / 1000).toFixed(3)} KD`,
      source: 'merchant',
      subjectType: 'product',
      subjectId: id,
      metadata: { name, priceFils },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string; pid: string } }>(
    '/salons/:id/products/:pid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      /**
       * `active` IS NOT EDITABLE HERE. Retiring a product is the DELETE below,
       * which is the design's ✕ and writes its own audit line; a second door into
       * the same field is how the tier ladder acquired an unvalidated entrance,
       * and "product edited" is the wrong sentence in an audit log for "product
       * withdrawn from sale".
       */
      const unknown = Object.keys(body).filter((k) => k !== 'name' && k !== 'priceFils');
      if (unknown.length > 0) {
        throw badRequest(
          'invalid_field',
          `Not editable: ${unknown.join(', ')}. A product has a name and a price.`,
        );
      }

      const patch: { name?: string; priceFils?: ReturnType<typeof parseAmountFils> } = {};
      if ('name' in body) patch.name = requireString(body.name, 'name', 200);
      if ('priceFils' in body) patch.priceFils = parseAmountFils(body.priceFils, 'priceFils');
      if (Object.keys(patch).length === 0) {
        throw badRequest('invalid_request', 'Send a name, a priceFils, or both.');
      }

      // Scoped to her own salon IN THE WHERE, not checked after the read: another
      // salon's product id must not be editable, and it must not be confirmable
      // to exist either. `active` is in the predicate too — a retired product is
      // not repriced back into the catalog by a PATCH.
      const [row] = await db
        .update(product)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(product.id, req.params.pid),
            eq(product.salonId, p.salonId),
            eq(product.active, true),
          ),
        )
        .returning({
          id: product.id,
          salonId: product.salonId,
          name: product.name,
          priceFils: product.priceFils,
        });
      if (!row) throw notFound('unknown_product', 'No such product.');

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Product edited',
        // What it is NOW. A price move matters to a merchant reading this later,
        // so the new value is spelled out rather than left to "edited".
        detail:
          `${row.name} · ${(row.priceFils / 1000).toFixed(3)} KD` +
          (patch.priceFils !== undefined ? ' (price changed)' : ''),
        source: 'merchant',
        subjectType: 'product',
        subjectId: row.id,
        metadata: { changed: Object.keys(patch), name: row.name, priceFils: row.priceFils },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.send(row);
    },
  );

  /**
   * The ✕. RETIRES, does not delete.
   *
   * `shop_order_line.product_id` is `ON DELETE restrict`, so a product that has
   * ever been sold cannot be removed — the database would refuse with a foreign
   * key error, which reaches a merchant as a 500 for pressing a button the design
   * drew. And it should not be removed: an order line naming a product that no
   * longer exists is a receipt with a dangling id in it.
   *
   * So this is `active = false`, which is what `service.active` has always been
   * and what `DELETE .../happy-hours/{hid}` does once a window has paid out. The
   * product leaves the catalog, every past order keeps its line, and the audit row
   * says which of the two happened.
   *
   * IDEMPOTENT BY PREDICATE, NOT BY SILENCE: a second DELETE finds no active row
   * and answers 404. That is a true statement — there is no such product on sale —
   * and it is what a dashboard that has just removed a row and lost the response
   * needs to hear, rather than a 204 implying it removed something.
   */
  app.delete<{ Params: { id: string; pid: string } }>(
    '/salons/:id/products/:pid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);

      const [row] = await db
        .update(product)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(product.id, req.params.pid),
            eq(product.salonId, p.salonId),
            eq(product.active, true),
          ),
        )
        .returning({ id: product.id, name: product.name, priceFils: product.priceFils });
      if (!row) throw notFound('unknown_product', 'No such product.');

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Product removed',
        // "Retired" rather than "deleted", because that is what happened and a
        // merchant asking why an old receipt still names it deserves the true
        // word in the log.
        detail: `${row.name} retired from the catalog`,
        source: 'merchant',
        subjectType: 'product',
        subjectId: row.id,
        metadata: { name: row.name, priceFils: row.priceFils, retired: true },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.code(204).send();
    },
  );

  /**
   * perms.appointments — the Merchant → Appointments screen.
   *
   * This route existed as an empty list so the ninth permission had a real
   * server-side gate rather than an unguarded 404 that looks like a gate and is
   * not. It now returns actual bookings.
   *
   * `?status=` takes the contract's four, comma-separated — the status pills the
   * design draws, "Deposit held / Completed / No-show · returned". Unknown values
   * are refused BY NAME rather than silently ignored: a dashboard filtering on a
   * typo would render an empty Appointments screen, and the merchant would read
   * that as "no bookings today", which is the worst possible answer to give a
   * salon about its own day.
   *
   * The customer's name, tier and phone are joined in, which the design asks for
   * and which `perms.appointments` is the gate for. `branchAssumed` comes out
   * too, for the reason it does on a transaction: a per-branch appointment count
   * that rests on a guess should be filterable rather than indistinguishable from
   * one that does not.
   *
   * =======================================================================
   * IT PAGES NOW, AND IT USED TO CLAIM IT DID NOT NEED TO
   * =======================================================================
   * This was `LIMIT 200` with `nextCursor: null` hardcoded — a capped list
   * reporting "no more pages". Lane C found the consequence by loading 211
   * further-out bookings: the list truncated, and because the order is
   * `starts_at DESC` THE ROWS DROPPED FIRST ARE THE ONES STARTING SOONEST. Its
   * client-side closure impact read 0 deposit-held appointments where
   * `closure-preview` correctly reported 3.
   *
   * A cursor rather than a bigger cap or a documented one, and the reason is the
   * shape of the lie rather than the size of the number: `nextCursor: null` is a
   * confident answer with nothing behind it, which any future consumer will
   * believe exactly as lane C's screen did. Raising the cap moves the cliff;
   * documenting it leaves a field that says something false. Neither is worth
   * the ten lines this costs.
   *
   * `services/streamCursor.ts` IS THE IMPLEMENTATION, not a fourth copy of
   * keyset logic — its own header records that this API already had two copies
   * before a third arrived, and that a drifting cursor "does not throw: it
   * silently skips rows, and the reader sees a shorter list rather than an
   * error", which is the same failure mode as the bug being fixed here. ONE
   * stream, so the rank is the constant 0 and the key is `(starts_at, id)`.
   *
   * THE ORDER IS UNCHANGED — `starts_at DESC` is what the design's Appointments
   * screen draws, and lane C reads it. Worth saying plainly that a cursor fixes
   * TRUNCATION and not the default view: the first page is still the furthest-
   * future appointments, and a merchant who wants today's has to page or filter.
   * Whether an appointments list should be newest-first at all is a product
   * question about a drawn screen, so it is reported rather than changed here.
   *
   * =======================================================================
   * `?from=` AND `?to=` — AND WHAT THEY DELETE
   * =======================================================================
   * Lane C's week grid could not ask for a week. So it walked this cursor
   * BACKWARDS THROUGH EVERY BOOKING NEWER THAN THE WEEK IT WANTED, and proved it
   * held the week whole before drawing anything — sound, because the stream is
   * `starts_at DESC` and a fetched row starting strictly before the window's
   * first day means nothing in the window is still out there. It cost a page
   * walk per week and carried a 12-page budget, after which the grid refused to
   * draw and told the merchant it had stopped short. A date range deletes that
   * whole mechanism: one page, no proof, no budget, no refusal.
   *
   * THEY ARE SALON-LOCAL CALENDAR DATES, NOT INSTANTS, and that is the whole
   * reason they are not `?after=`/`?before=` ISO timestamps. A grid asks a
   * CALENDAR question — "Sunday the 8th to Saturday the 14th" — and a client
   * that had to turn that into instants would be doing offset arithmetic against
   * a zone it holds a stale copy of. "8 March" at a Kuwait salon begins at 21:00Z
   * on 7 March; a week resolved in UTC instead moves both ends three hours,
   * dropping Saturday's last three appointments and picking up the Saturday
   * before's in their place. The merchant would see a grid she could not
   * reconcile against her own book at either end, with nothing on the page to say
   * it was a boundary rather than a cancellation.
   *
   * THE INTERVAL IS HALF-OPEN, `[from 00:00, to+1 00:00)` IN THE SALON'S ZONE —
   * which is `resolveWindow`'s convention, unchanged, because this IS
   * `resolveWindow`: `parseCalendarRange` returns the same calendar `Period` that
   * `?period=2026-03-01_2026-03-31` returns and the same function resolves it.
   * No date arithmetic was written here. What that openness MEANS to the
   * merchant is both days inclusive — a 23:59 salon-local appointment on `to` is
   * in the week, a 00:00 one on the day after is not — which is what "Sun–Sat"
   * means when she says it out loud, and the endpoint should mean what she means.
   *
   * THE RANGE IS ANOTHER `AND`, NOT A REPLACEMENT. `?status=` still filters, the
   * cursor still pages, the order is still `starts_at DESC, id ASC`, and the
   * tiebreak below is untouched — a range is a CONTIGUOUS SLICE of that same
   * total order, so a page boundary inside a group of bookings sharing an instant
   * behaves identically whether or not a window is applied. `nextCursor` still
   * tells the truth: a range makes 200 rarely binding, but a busy salon's week
   * can still page and the `+ 1` probe is what decides it, not the range.
   *
   * ABSENT IS UNCHANGED, DELIBERATELY AND PROVABLY. `parseCalendarRange` returns
   * `null` when neither is given, no predicate is added, AND THE SALON ROW IS NOT
   * READ — so a request without them issues exactly the query it issued before
   * this parameter existed. Lane C switches to the range when it is ready; until
   * then both the walk and the window have to work.
   *
   * `booking_salon_starts_idx` IS `(salon_id, starts_at DESC)` and already
   * existed. The range predicate is a bounded scan of the same index the order by
   * already uses, which is why this is cheap rather than merely correct.
   */
  app.get<{
    Params: { id: string };
    Querystring: { status?: string; cursor?: string; from?: string; to?: string };
  }>(
    '/salons/:id/bookings',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      const raw = req.query?.status;
      const wanted =
        typeof raw === 'string' && raw.trim() !== ''
          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
          : null;
      if (wanted) {
        const unknown = wanted.filter((s) => !(BOOKING_STATUSES as readonly string[]).includes(s));
        if (unknown.length > 0) {
          throw badRequest(
            'invalid_status',
            `Unknown booking status: ${unknown.join(', ')}. One of ${BOOKING_STATUSES.join(', ')}.`,
          );
        }
      }

      /**
       * `[0]` is this endpoint's whole rank set, so a cursor minted by one of the
       * multi-stream reads cannot address a stream here — `parseCursor` refuses
       * it by name rather than walking a rank that means nothing.
       */
      const cursor = parseCursor(req.query?.cursor, [0]);

      /**
       * PARSED BEFORE THE SALON IS READ, RESOLVED AFTER — `services/period.ts` §
       * `parsePeriod` states the split and `routes/reports.ts` orders the same
       * three calls the same way. Parsing answers "what did she ask for" and
       * needs no zone; resolving answers "which instants is that" and cannot be
       * done until the salon row is in hand. Fusing them would force the lookup
       * ahead of the refusal, and a caller who cleared the gate would learn from
       * a 404-vs-400 whether the salon exists before her parameters were judged.
       */
      const range = parseCalendarRange(req.query?.from, req.query?.to);

      /**
       * THE LOOKUP HAPPENS ONLY FOR A RANGE, which is how "no params = today's
       * behaviour" is a fact about the code rather than a hope about it: with no
       * range there is no second query, no `unknown_salon` path that did not
       * exist before, and nothing added to the `where`.
       *
       * `new Date()` is unread for a calendar window — `resolveWindow` only
       * consults `now` on the rolling branch — and is passed rather than faked
       * because the signature is the shared one and a sentinel here would be a
       * lie a future rolling caller could trip over.
       */
      let dateWindow: PeriodWindow | null = null;
      if (range) {
        const salonRows = await db
          .select({ id: salon.id, timezone: salon.timezone })
          .from(salon)
          .where(eq(salon.id, req.params.id))
          .limit(1);
        const s = salonRows[0];
        if (!s) throw notFound('unknown_salon', 'No such salon.');
        dateWindow = resolveWindow(range, s.timezone, new Date());
      }

      const rows = await db
        .select({
          b: booking,
          /**
           * MICROSECOND-EXACT, as text. `timestamptz` stores microseconds and
           * `toISOString()` emits milliseconds, so a cursor built from the
           * serialised `startsAt` would truncate and END THE WALK — the defect
           * streamCursor.ts records against `GET /v1/support/tickets`.
           */
          at: cursorInstant(booking.startsAt),
          memberName: member.name,
          memberPhone: member.phone,
          /**
           * WITH THE PHONE, ALWAYS. This join is live, so an erased member
           * appears here as the `+990` tombstone `services/erasure.ts` minted —
           * `http/serialise.ts § serialiseMemberContact` is why that cannot be
           * served as `memberPhone`, and this column is what lets the answer be
           * derived from `erased_at` rather than from the digits.
           */
          memberErasedAt: member.erasedAt,
          memberTier: member.tier,
          artistName: artist.name,
          serviceName: service.name,
        })
        .from(booking)
        /**
         * LEFT, AND THIS WAS AN `innerJoin` UNTIL MIGRATION 0056 MADE IT A BUG.
         *
         * `booking.member_id` became nullable so that a hand-written appointment
         * can name a WALK-IN instead of a member. An inner join on a nullable
         * column drops every row where it is null — so every guest appointment
         * would vanish from THE MERCHANT'S OWN BOARD, which is the one screen the
         * feature exists for. The front desk would write an appointment down and
         * watch it not appear.
         *
         * Worse than a missing row, too: `nextCursor` is minted from the page's
         * last surviving row, so guests disappearing mid-page would silently
         * shorten pages and the cursor walk would step over them without ever
         * reporting a gap.
         */
        .leftJoin(member, eq(member.id, booking.memberId))
        .innerJoin(artist, eq(artist.id, booking.artistId))
        .innerJoin(service, eq(service.id, booking.serviceId))
        .where(
          and(
            eq(booking.salonId, req.params.id),
            wanted
              ? inArray(booking.status, wanted as Array<BookingRow['status']>)
              : undefined,
            /**
             * HALF-OPEN, `[fromInstant, toInstant)`, on `starts_at` — the column
             * the order and the cursor are already keyed on, so the window is a
             * contiguous slice of one total order rather than a second one. A
             * booking AT `fromInstant` is in; a microsecond before it is out.
             * `toInstant` is salon midnight at the START of the day after `to`,
             * so `to`'s 23:59 is in and the next day's 00:00 is not.
             *
             * `ends_at` is deliberately not consulted: a grid draws an
             * appointment on the day it STARTS, and a window on both columns
             * would pull an appointment that began the previous evening into a
             * week that does not draw it.
             */
            dateWindow ? gte(booking.startsAt, dateWindow.fromInstant) : undefined,
            dateWindow ? lt(booking.startsAt, dateWindow.toInstant) : undefined,
            afterCursor(cursor, 0, booking.startsAt, booking.id),
          ),
        )
        /**
         * `starts_at DESC, id ASC` — the tiebreak direction is not arbitrary. It
         * has to match `afterCursor`'s own comparison, which at an equal instant
         * asks for `id > cursorId`. Two bookings can share a `starts_at` to the
         * microsecond (two artists, one 10:00 slot), and without a matching total
         * order a page boundary inside that group repeats a row or loses one.
         */
        .orderBy(desc(booking.startsAt), asc(booking.id))
        /**
         * `+ 1` is how "is there another page" is answered without a second
         * COUNT that could see a different world. The extra row is never sent.
         */
        .limit(BOOKINGS_PAGE + 1);

      const page = rows.slice(0, BOOKINGS_PAGE);
      const last = page[page.length - 1];

      return reply.send({
        items: page.map((r) => ({
          ...serialiseBooking(r.b as BookingRow),
          branchAssumed: r.b.branchAssumed,
          /**
           * The tombstone NAME survives untouched — "Deleted account" is what
           * this board should say. The phone does not: same contract as
           * `GET /v1/salons/{id}/orders` and `GET /artists/me/bookings`, applied
           * through the same function so the three cannot drift apart.
           */
          /**
           * A GUEST ROW SERVES THE NAME THE FRONT DESK WROTE DOWN. One field, one
           * meaning — "who is this appointment for" — rather than a second field
           * every client would have to learn before it could draw a row it is
           * already being sent. `booking_identity_exactly_one` makes the fallback
           * total: `guest_name` is non-null exactly when `member_id` is null.
           *
           * THE TOMBSTONE IS UNAFFECTED. An erased member still has a name — the
           * "Deleted account" string `services/erasure.ts` scrubbed it to — so
           * `r.memberName` is non-null and `??` never fires on a member row.
           */
          memberName: r.memberName ?? r.b.guestName,
          /**
           * AND SO IS THE ERASURE CONTRACT. `serialiseMemberContact` is still the
           * only thing that decides whether a number may be shown, and it still
           * decides on `erased_at`. A guest has no member row and therefore no
           * `erased_at`, so her number is served and `memberErased` is false —
           * which is the truth about her: there is no account, so there is no
           * erased account.
           */
          ...serialiseMemberContact({
            phone: r.memberPhone ?? r.b.guestPhone,
            erasedAt: r.memberErasedAt,
          }),
          memberTier: r.memberTier,
          artistName: r.artistName,
          serviceName: r.serviceName,
        })),
        /**
         * NULL ONLY WHEN IT IS TRUE. `rows.length > BOOKINGS_PAGE` means the
         * `+ 1` row came back, so there is provably at least one more.
         */
        nextCursor:
          rows.length > BOOKINGS_PAGE && last
            ? encodeCursor({ at: last.at, rank: 0, id: last.b.id })
            : null,
      });
    },
  );

  /**
   * The service list. Readable by anyone who may scan — and, since the Book
   * flow, by the customer choosing what she is booking.
   *
   * `ServiceSchema` IS THE SHAPE, ALL FIVE FIELDS. This route served
   * `{id, name, priceFils}` against a contract that also declares `salonId`,
   * `nameAr` and `active`, so the wallet's most Arabic-heavy screen rendered
   * Latin service names — `name_ar` did not exist until migration 0022, and the
   * two fields that did exist were simply never selected.
   *
   * `active` IS EMITTED AND THE LIST IS STILL FILTERED ON IT, which reads like a
   * contradiction and is not. The filter is a rule about money: a retired
   * service cannot be charged — services/charge.ts prices a basket from these
   * rows — so offering one would build a basket the charge handler then refuses
   * at the counter. The field is contract conformance: `ServiceSchema` declares
   * it non-optional, and a response omitting it fails `.parse()` in every client
   * that validates. It is `true` on every row here, and that is a true
   * statement rather than a placeholder.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/services', async (req, reply) => {
    const p = requireSalonScoped(req);
    requireSameSalon(p, req.params.id);

    /**
     * Authority first, then the module — `reports.ts` § `build`'s ordering. A
     * customer of a salon that does not take appointments is not shown the list
     * she would book from; staff still read it, because the scanner prices a
     * charge from these same rows and a counter sale is not an appointment.
     */
    const [mod] = await db
      .select({ moduleBooking: salon.moduleBooking })
      .from(salon)
      .where(eq(salon.id, req.params.id))
      .limit(1);
    if (!mod) throw notFound('unknown_salon', 'No such salon.');
    assertBookingReadable(p.kind, mod);

    const rows = await db
      .select({
        id: service.id,
        salonId: service.salonId,
        name: service.name,
        nameAr: service.nameAr,
        priceFils: service.priceFils,
        active: service.active,
      })
      .from(service)
      .where(and(eq(service.salonId, req.params.id), eq(service.active, true)));

    /** The same contract addition as the products route above. Same caveat. */
    const images = await primaryImagesFor(
      db,
      req.params.id,
      'service',
      rows.map((r) => r.id),
    );
    return reply.send({
      items: rows.map((r) => ({ ...r, image: images.get(r.id) ?? null })),
      nextCursor: null,
    });
  });
}
