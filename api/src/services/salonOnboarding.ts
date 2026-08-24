/**
 * Onboarding a salon — the four-step wizard's write, as one transaction.
 *
 * THE GAP THIS CLOSES. `DECISIONS.md` § "White-label onboarding is a wizard":
 * there was no way to create a salon. No `POST /salons`, no
 * `POST /v1/platform/salons`, and `api-contract.md` names neither, so every salon
 * in existence is there because `seed.ts` inserted it and onboarding a real client
 * meant a hand-written INSERT.
 *
 * NOTHING HERE IS INVENTED. `design/README.md:165` and
 * `AVO Owner Console.dc.html` § ONBOARDING WIZARD draw the flow — Salons →
 * "+ Onboard a salon", four steps (details & plan → modules & deposit → loyalty &
 * brand colour → review), then "Create salon & send invite". The field set below
 * is that wizard's `wName / wCity / wPhone / wPlan / wBooking / wShop / wDeposit /
 * wLoyalty / wBrand`, and the default tier ladder is the one its own `wizNext`
 * writes and its own copy describes ("Bronze / Silver / Gold / Black start at 0,
 * 4, 10 and 20 visits with 0, 10, 20 and 30% top-up bonus").
 *
 * ================================ ATOMICITY ================================
 * ONE TRANSACTION, and the reason is non-negotiable #3's reason rather than an
 * analogy to it. This write produces five things that are worthless apart:
 *
 *   the salon row · its first branch · the owner's staff account ·
 *   the invite in the outbox · the audit rows
 *
 * `build-plan.md` calls a half-published tier ladder a money bug, and a salon
 * created with no ladder is the same bug at its worst moment: a member could top
 * up against a configuration that does not exist yet. `salon.tiers` is one jsonb
 * column so the ladder cannot half-write, and this transaction is what stops the
 * salon existing without one — or with an owner account nobody can sign into
 * because the invite never landed, or with an invite pointing at a staff row that
 * was rolled back.
 *
 * ============================== IDEMPOTENCY ================================
 * REQUIRED, and #4's letter does not cover it: "top-ups, charges, orders, voids".
 * The argument is #4's REASON — a retry must not apply an effect twice — plus what
 * the alternatives actually are here:
 *
 *   - THERE IS NO NATURAL KEY. Two real salons can share a name; "Glow Bar" in
 *     Salmiya and "Glow Bar" in Hawally are two clients. A UNIQUE on `name` would
 *     refuse the second one, which is a worse failure than the one it prevents.
 *   - THE ID IS SERVER-MINTED, so a retry cannot be idempotent by id the way a
 *     PUT would be.
 *   - A DOUBLE SUBMIT IS NOT MERELY A DUPLICATE ROW. It mints a second owner
 *     account and a second WhatsApp invite, so the console's double-tapped
 *     "Create salon & send invite" would send the client two sign-ins for two
 *     different salons, one of which is a ghost with her members nowhere near it.
 *
 * So the key is claimed INSIDE this transaction, like every other money-adjacent
 * POST here, and the loser of the unique-violation race replays the winner's
 * stored 201 rather than computing a second one. `services/idempotency.ts` carries
 * the mechanism and why a check-then-act map does not survive two instances.
 *
 * ============================== THE INVITE =================================
 * NO FOURTH AD-HOC SENDER. Three flows already do this — `staff_password_reset`,
 * `platform_admin_password_reset`, `member_password_reset` — and all three write
 * an outbox row and leave `sent_at` NULL, because the WhatsApp templates are
 * unapproved and the sending domain is an open client decision (CLAUDE.md
 * escalations). This one REUSES `staff_password_reset` rather than adding a
 * fourth table: the design's promise is "a WhatsApp invite with their dashboard
 * sign-in", the dashboard sign-in is a `staff_user` with a NULL `password_hash`,
 * and a link that sets that password is exactly what that table is. The
 * destination is `salon.owner_phone`.
 *
 * `delivered: false` is on the response for the reason `POST
 * /staff/{id}/password-reset` puts it there: the console must not print "invite
 * sent" for a message no process will pick up.
 *
 * ============================== NOT BUILT ==================================
 * THE 14-DAY TRIAL HAS NO COLUMN. The review step's copy promises one — "opens a
 * 14-day trial before the first invoice" — and there is no trial, subscription or
 * invoice anywhere in this schema (`grep -i trial` across `api/src`,
 * `packages/types` and `api-contract.md` returns one unrelated sentence). The
 * console's Billing section is designed and has no API at all behind it: MRR,
 * commission, outstanding, per-salon fees, invoice list. Inventing a
 * `trial_ends_at` here would be a date nothing reads, which is the "capability
 * that exists and goes unused" pattern `services/platformSettings.ts` names.
 * REPORTED as a gap of the same class trunk already deferred for logo and
 * typography storage — the wizard's copy is ahead of the schema, and the fix is a
 * billing slice, not a column smuggled in with this one.
 */

import { formatMoney, type Fils } from '@avo/types';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { branch, salon } from '../db/schema/salon';
import { staffPasswordReset, staffUser } from '../db/schema/staff';
import {
  PERM_COLUMN,
  PERMISSION_NAMES,
  type PlatformPrincipal,
} from '../auth/principal';
import {
  hashPasswordResetToken as hashResetToken,
  mintPasswordResetToken as mintResetToken,
} from '../auth/tokens';
import { badRequest, conflict } from '../http/errors';
import { parseBusinessHours, parseE164 } from '../http/fields';
import { requireString } from '../money/validate';
import { parseTimeZone } from '../time/zone';
import { writeAudit } from './audit';
import { parseBrandColor } from './brandColor';
import { claimKey, completeKey } from './idempotency';
import { parseLoyaltyConfig, type LoyaltyConfig } from './loyaltyRules';
/**
 * A SERVICE IMPORTING A ROUTE MODULE, and the direction is deliberate rather than
 * accidental. `routes/salons.ts` is where the Salon wire shape, the deposit range
 * and the branch-id generator are DEFINED, and its own header states the rule this
 * import exists to keep: "one function, so a read and a write cannot disagree".
 * Re-declaring any of the three here would be the second door `EDITABLE`'s comment
 * warns about. `routes/members.ts` already imports `serialiseMember` from
 * `routes/auth.ts` for the same reason. `routes/salons.ts` does not import this
 * module, so there is no cycle; moving all three into a service module would be a
 * better home and a bigger refactor than this slice.
 */
import { branchId, parseDepositFils, serialiseSalon, type SalonView } from '../routes/salons';

/**
 * Every field this endpoint accepts. Anything else is refused BY NAME, not
 * ignored — `PATCH /salons/{id}` and `PATCH /v1/platform/admins/{id}` both do
 * this, and the reason is the same: a console that sent `social` or `active`
 * believed it had set something.
 *
 * `active` is worth calling out because the design draws a Live toggle on the
 * salon list ("flip it off to instantly suspend it") and THERE IS NO SUCH COLUMN
 * — a reported design gap that `routes/platformConsole.ts` already refuses to
 * fake with `true`. A body carrying it gets a sentence rather than silence.
 */
const ACCEPTED = new Set([
  // step 1 — details & plan
  'name',
  'nameAr',
  'city',
  'ownerPhone',
  'plan',
  // step 2 — modules & deposit
  'modules',
  'depositFils',
  // step 3 — loyalty & brand colour
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
  'brandColor',
  /**
   * Not drawn by the wizard, accepted because the columns are NOT NULL and a
   * default is a decision either way. See `DEFAULT_BUSINESS_HOURS` and
   * `salon.timezone` — "10:00" is a string until something says which clock.
   */
  'timezone',
  'businessHours',
  /**
   * The owner's identity, and the wizard collects NEITHER. It asks for the
   * owner's WhatsApp number and nothing else, so the defaults below are derived
   * — and these two are accepted so Lane C can add the fields to step 1 without
   * an API change, rather than being forced through a hand-written UPDATE.
   */
  'ownerName',
  'ownerHandle',
  /** Defaults to the city, exactly as the wizard's own `wizNext` does. */
  'branchName',
  'branchNameAr',
]);

/**
 * The Kuwaiti day, and the same hours `seed.ts` gives Amara.
 *
 * The wizard does not ask, and `business_hours` is NOT NULL with no column
 * default, so something has to answer. This is the design bundle's own answer:
 * `BusinessHoursSchema` documents the afternoon closure as "the norm, not an edge
 * case", and a salon whose real hours differ changes them from her own Settings
 * screen on day one. The alternative — 00:00–23:59 — would make every booking
 * slot valid on a screen nobody had configured yet.
 */
const DEFAULT_BUSINESS_HOURS = {
  morning: ['10:00', '13:00'],
  evening: ['16:00', '21:00'],
} as const;

/**
 * The design's own default ladder, from `wizNext` in
 * `AVO Owner Console.dc.html`, translated into the contract's field names
 * (`visits`/`bonus` there, `minVisits`/`bonusPercent` here and in
 * `packages/types`).
 *
 * It is passed through `parseLoyaltyConfig` like anything a client sends, so it
 * is validated rather than trusted — and `salonOnboarding.test.ts` asserts that
 * separately, because the one path that returns this constant untouched
 * (`loyaltyMode: 'tiers'` with no `tiers` in the body) is the wizard's own
 * default path and would otherwise be the only unvalidated ladder in the system.
 */
const DEFAULT_TIERS = [
  { name: 'bronze', minVisits: 0, bonusPercent: 0 },
  { name: 'silver', minVisits: 4, bonusPercent: 10 },
  { name: 'gold', minVisits: 10, bonusPercent: 20 },
  { name: 'black', minVisits: 20, bonusPercent: 30 },
] as const;

/**
 * "8 stamps for a free blow-dry" — the wizard's stamps copy, and the same target
 * `seed.ts` gives Amara.
 */
const DEFAULT_STAMP_TARGET = 8;

/** The base a new salon's loyalty configuration is resolved against. */
export const DEFAULT_LOYALTY: LoyaltyConfig = {
  mode: 'tiers',
  tiers: DEFAULT_TIERS.map((t) => ({ ...t })),
  stampTarget: DEFAULT_STAMP_TARGET,
  stampReward: null,
  stampRewardAr: null,
};

/**
 * How long the invite link is good for. SIXTY MINUTES, the same window
 * `routes/staff.ts` and `routes/platformAdmins.ts` use, and it is worth saying
 * why an onboarding invite gets the short one: it is a credential in transit, and
 * two surfaces having different windows would be a difference nobody chose. If a
 * client needs longer, that is a re-issue — `POST /staff/{id}/password-reset`
 * already exists and already mints a fresh one.
 */
const INVITE_TTL_MINUTES = 60;

/** The design's three plans, lowercase as the `salon_plan` enum spells them. */
const PLANS = ['starter', 'growth', 'pro'] as const;
type Plan = (typeof PLANS)[number];

export interface OnboardInput {
  name: string;
  nameAr: string | null;
  city: string;
  ownerPhone: string;
  plan: Plan;
  moduleBooking: boolean;
  moduleShop: boolean;
  depositFils: Fils;
  loyalty: LoyaltyConfig;
  brandColor: string;
  timezone: string;
  businessHours: { morning: [string, string]; evening: [string, string] };
  ownerName: string;
  ownerHandle: string;
  branchName: string;
  branchNameAr: string | null;
}

/** An empty string is not a translation — `routes/salons.ts § NULLABLE_ARABIC`. */
function optionalArabic(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `${field} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `{ booking, shop }`, and BOTH DEFAULT OFF.
 *
 * Not a convention — `AVO-Beauty-Product-Description-v2.md` § Settings says
 * "module toggles (Booking, Shop — both default OFF)", the columns carry that
 * default, and the wizard's own step 2 says it in words: "Modules start off. Turn
 * on only what this salon has agreed to run." A partial object is honoured, so
 * `{ booking: true }` leaves Shop off rather than resetting a field the caller
 * did not mention — `applyModules` in `routes/salons.ts` reasons the same way.
 */
function parseModules(value: unknown): { moduleBooking: boolean; moduleShop: boolean } {
  if (value === undefined) return { moduleBooking: false, moduleShop: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_request', 'modules must be an object like { booking, shop }.');
  }
  const incoming = value as Record<string, unknown>;
  for (const key of Object.keys(incoming)) {
    if (key !== 'booking' && key !== 'shop') {
      throw badRequest(
        'unknown_module',
        `Unknown module: ${key}. The modules are booking and shop.`,
      );
    }
    if (typeof incoming[key] !== 'boolean') {
      throw badRequest('invalid_request', `modules.${key} must be true or false.`);
    }
  }
  return {
    moduleBooking: incoming.booking === true,
    moduleShop: incoming.shop === true,
  };
}

/**
 * The deposit — defaulted from the PLATFORM's own new-salon default when the body
 * is silent, and otherwise refused by `routes/salons.ts`'s own parser.
 *
 * `platform_settings.new_salon_deposit_fils` is the owner console's Controls
 * stepper, labelled "default deposit" and described by the schema as the value a
 * new salon starts with. NOTHING READ IT. It has been settable since 0032 and
 * only ever echoed back by `GET`/`PATCH /v1/platform/settings`, which is the
 * pattern `services/platformSettings.ts` names about the commission: "a
 * capability that exists and goes unused… the constant is right, the column is
 * right, and nothing joins them". This is the join.
 *
 * THE RANGE CHECK IS IMPORTED, NOT RESTATED. `parseDepositFils` already refuses
 * a fraction and anything outside 1–10 KD with a sentence about the range, and a
 * second copy here would be a second wording of one rule — the shape of defect
 * `routes/salons.ts` records against `tiers`, and it would also mean a second
 * place doing `/ 1000` to money. The platform default is not re-checked because
 * `platform_settings` carries its own CHECK over the same bounds, for the reason
 * migration 0032 gives.
 */
function parseDeposit(value: unknown, platformDefault: Fils): Fils {
  if (value === undefined) return platformDefault;
  return parseDepositFils(value);
}

/**
 * The plan, LOWER-CASED at the door.
 *
 * The design's buttons are labelled `Starter / Growth / Pro` and its state holds
 * the label verbatim (`wPlan: 'Growth'`); the `salon_plan` enum and
 * `api-contract.md` are lowercase. Case-folding here rather than accepting two
 * spellings is the same treatment `handle` gets in `routes/staff.ts` and
 * `routes/platformAdmins.ts` — one stored form, and a client that sends the
 * drawn label is not punished for reading the design.
 */
function parsePlan(value: unknown): Plan {
  if (value === undefined) return 'starter';
  if (typeof value !== 'string') {
    throw badRequest('invalid_plan', `plan must be one of ${PLANS.join(', ')}.`);
  }
  const lowered = value.trim().toLowerCase();
  if (!(PLANS as readonly string[]).includes(lowered)) {
    throw badRequest('invalid_plan', `plan must be one of ${PLANS.join(', ')}.`);
  }
  return lowered as Plan;
}

/**
 * `businessHours` — the default when the wizard is silent, otherwise the shared
 * parser.
 *
 * The validation itself moved to `http/fields.ts` when `PATCH /salons/{id}` got
 * the same guard: that was the last unvalidated jsonb door on this table, and a
 * bad save there turns every availability read into a 500 out of
 * `hhmmToMinutes`. Both doors now call one function, for the reason the file this
 * lives in states about `parseE164`.
 */
function businessHoursOrDefault(value: unknown): OnboardInput['businessHours'] {
  if (value === undefined) {
    return {
      morning: [...DEFAULT_BUSINESS_HOURS.morning],
      evening: [...DEFAULT_BUSINESS_HOURS.evening],
    };
  }
  return parseBusinessHours(value);
}

/** Letters, digits, dot, dash, underscore — `POST /staff`'s rule, restated. */
function parseHandle(value: unknown): string {
  if (value === undefined) {
    /**
     * `owner`. `staff_user_salon_handle_uq` is per-salon, so on a salon that does
     * not exist yet this cannot collide — and it is the handle a person can be
     * told over the phone. The wizard collects no username at all; see ACCEPTED.
     */
    return 'owner';
  }
  const handle = requireString(value, 'ownerHandle', 60).toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9._-]+$/.test(handle)) {
    throw badRequest(
      'invalid_handle',
      'A handle is letters, numbers, dots, dashes and underscores — no spaces.',
    );
  }
  return handle;
}

/**
 * Validate the whole body. Nothing is written until this returns.
 *
 * Takes the platform's settings row rather than reading it, so the caller can
 * read it once and the deposit default comes from the same snapshot the audit
 * row describes.
 */
export function parseOnboardInput(
  body: Record<string, unknown>,
  platformDefaultDepositFils: Fils,
): OnboardInput {
  const rejected = Object.keys(body).filter((k) => !ACCEPTED.has(k));
  if (rejected.length > 0) {
    throw badRequest(
      'not_settable_here',
      `These fields cannot be set when onboarding a salon: ${rejected.join(', ')}.`,
    );
  }

  /**
   * The three the wizard itself requires. `wizReady` in the design gates its
   * Continue button on exactly these — `s.wName.trim() && s.wCity.trim() &&
   * s.wPhone.trim()` — so requiring them here is the same rule enforced on the
   * side that matters. #7's reasoning generalises: the UI disabling a button is a
   * courtesy, not a control.
   */
  const name = requireString(body.name, 'name', 200);
  const city = requireString(body.city, 'city', 120);
  const ownerPhone = parseE164(body.ownerPhone);

  const modules = parseModules(body.modules);
  const branchName = requireString(
    // The wizard names the first branch after the city:
    // `branches: [{ id: 'BR-NEW', name: x.wCity }]`.
    body.branchName === undefined ? city : body.branchName,
    'branchName',
    120,
  );

  return {
    name,
    nameAr: optionalArabic(body.nameAr, 'nameAr'),
    city,
    ownerPhone,
    plan: parsePlan(body.plan),
    ...modules,
    depositFils: parseDeposit(body.depositFils, platformDefaultDepositFils),
    /**
     * ONE VALIDATOR, the publish endpoint's. `parseLoyaltyConfig` resolves the
     * fields the body did not mention against `DEFAULT_LOYALTY` and returns a
     * COMPLETE configuration, which is what lets the INSERT below satisfy
     * `salon_loyalty_config_complete` in one statement. Re-deriving the ladder
     * rules here would be the unvalidated second entrance `routes/salons.ts`
     * records against `tiers`.
     */
    loyalty: parseLoyaltyConfig(body, DEFAULT_LOYALTY),
    /**
     * Non-negotiable #9's second clause, on the create door. The refusal carries
     * `deriveBrandSet`'s own reason — see `services/brandColor.ts`. Defaulted to
     * the wizard's own first swatch when absent, which the design pre-selects
     * (`wBrand: '#6E7F6C'`) and which derives cleanly.
     */
    brandColor: body.brandColor === undefined ? '#6E7F6C' : parseBrandColor(body.brandColor),
    timezone: body.timezone === undefined ? 'Asia/Kuwait' : parseTimeZone(body.timezone),
    businessHours: businessHoursOrDefault(body.businessHours),
    ownerName: body.ownerName === undefined ? `${name} owner` : requireString(body.ownerName, 'ownerName', 120),
    ownerHandle: parseHandle(body.ownerHandle),
    branchName,
    branchNameAr: optionalArabic(body.branchNameAr, 'branchNameAr'),
  };
}

/**
 * `SAL-AMARA`. Readable, because it goes in audit rows a human reads — the same
 * choice `platform_admin.id` makes ("'PA-YOUSEF'. Not a uuid: it appears in
 * audit rows a human reads").
 *
 * A COLLISION IS NOT AN ERROR. Two clients can be called "Glow Bar", so the
 * suffix search below is what keeps a second one from being refused. It is a
 * check-then-act and the transaction's own `salon_pkey` is the backstop: two
 * console admins onboarding same-named salons in the same instant lose one to a
 * unique violation, which `onboardSalon` translates into a named 409 rather than
 * a 500. Not solved with a random suffix because `SAL-GLOWBAR-K3F9` is a worse
 * audit row every day of the year in exchange for a race nobody will hit.
 */
export async function mintSalonId(exec: Db, name: string): Promise<string> {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  const base = `SAL-${slug === '' ? 'SALON' : slug}`;

  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : `${base}${n}`;
    const [clash] = await exec
      .select({ id: salon.id })
      .from(salon)
      .where(eq(salon.id, candidate))
      .limit(1);
    if (!clash) return candidate;
  }
  throw conflict(
    'salon_name_exhausted',
    'Fifty salons already share that name. Give this one a distinguishing name.',
  );
}

export interface OnboardResult {
  status: number;
  body: {
    salon: SalonView;
    owner: { staffId: string; name: string; handle: string; role: string; passwordSet: false };
    invite: {
      channel: 'whatsapp';
      to: string;
      expiresAt: string;
      /** No sender is wired. See the header. */
      delivered: false;
    };
  };
}

export interface OnboardContext {
  principal: PlatformPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Create the salon, its first branch, its owner account and the owner's invite —
 * all of it or none of it.
 *
 * The `salonId` is minted OUTSIDE the transaction on purpose: the probe is a read
 * and holding the transaction open across it buys nothing, while the unique index
 * inside still decides the race.
 */
export async function onboardSalon(
  db: Db,
  input: OnboardInput,
  salonId: string,
  ctx: OnboardContext,
): Promise<OnboardResult> {
  const inviteToken = mintResetToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MINUTES * 60_000);

  return db.transaction(async (tx) => {
    // FIRST, so the unique index resolves a double submit before any row exists.
    const keyId = await claimKey(tx, ctx.idempotency);

    const [created] = await tx
      .insert(salon)
      .values({
        id: salonId,
        name: input.name,
        nameAr: input.nameAr,
        city: input.city,
        ownerPhone: input.ownerPhone,
        plan: input.plan,
        brandColor: input.brandColor,
        moduleBooking: input.moduleBooking,
        moduleShop: input.moduleShop,
        /**
         * The whole loyalty configuration, in ONE INSERT. `parseLoyaltyConfig`
         * returned a complete one, so `salon_loyalty_config_complete` is
         * satisfied by this statement rather than by a follow-up UPDATE — the
         * atomicity the header argues for, made structural.
         */
        loyaltyMode: input.loyalty.mode,
        tiers: input.loyalty.tiers,
        stampTarget: input.loyalty.stampTarget,
        stampReward: input.loyalty.stampReward,
        stampRewardAr: input.loyalty.stampRewardAr,
        depositFils: input.depositFils,
        timezone: input.timezone,
        businessHours: input.businessHours,
      })
      .returning();
    if (!created) throw new Error('salon insert returned no row');

    const [firstBranch] = await tx
      .insert(branch)
      .values({
        id: branchId(),
        salonId: created.id,
        name: input.branchName,
        nameAr: input.branchNameAr,
      })
      .returning();
    if (!firstBranch) throw new Error('branch insert returned no row');

    /**
     * THE OWNER ACCOUNT, holding everything.
     *
     * `role: 'owner'` and all nine permissions true, which is what the design
     * renders for an owner on both consoles ("Owner · full access") and what
     * `staff_user_void_implies_charges` needs anyway. `branchAccessAll` true
     * rather than the new branch's id: an owner reaches every branch, present
     * and future, and `staff_user_branch_access_exclusive` says the two
     * representations cannot both be populated.
     *
     * `password_hash` and `pin_hash` are BOTH NULL. Non-negotiable #6 — the
     * console never sets a password, it sends a link. She has no PIN either
     * until she or a manager binds one to a device.
     */
    const ownerStaffId = `ST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const [owner] = await tx
      .insert(staffUser)
      .values({
        id: ownerStaffId,
        salonId: created.id,
        name: input.ownerName,
        handle: input.ownerHandle,
        role: 'owner',
        branchAccessAll: true,
        branchAccessIds: [],
        passwordHash: null,
        pinHash: null,
        ...Object.fromEntries(PERMISSION_NAMES.map((n) => [PERM_COLUMN[n], true])),
      })
      .returning();
    if (!owner) throw new Error('owner staff insert returned no row');

    /**
     * THE INVITE, as an outbox row. Only the sha256 is stored; the token lives in
     * the message and nowhere else, and no endpoint returns it — the same
     * discipline `session.refresh_token_hash` and `wallet_token.token_hash` get.
     * `sent_at` stays NULL until a sender exists.
     */
    await tx.insert(staffPasswordReset).values({
      staffId: owner.id,
      salonId: created.id,
      tokenHash: hashResetToken(inviteToken),
      requestedBy: ctx.principal.name,
      expiresAt,
    });

    /**
     * TWO AUDIT ROWS, because two different things happened and the console's
     * filters are the reason to keep them apart. `rules` is the salon and its
     * configuration — the same kind `PATCH /salons/{id}` writes. `access` is a
     * credential coming into existence, the same kind `POST /staff` and the
     * console's admin invite write. One combined row would be invisible under
     * whichever filter it was not filed as.
     *
     * `salonId` is the NEW salon on both, so an AVO action on a salon appears in
     * that salon's log — `seed.ts` § the platform-actor rows makes the same
     * point.
     */
    await writeAudit(tx, ctx.principal, {
      salonId: created.id,
      kind: 'rules',
      action: 'Salon onboarded',
      detail:
        `${created.name} · ${created.city} · ${created.plan} plan · ` +
        // `formatMoney`, not `/ 1000` and `toFixed` — the display boundary is a
        // function in `@avo/types` and an audit line is a display.
        `deposit ${formatMoney(created.depositFils)} · ` +
        `${input.loyalty.mode === 'tiers' ? 'tiers' : `stamps (${input.loyalty.stampTarget})`} · ` +
        `brand ${created.brandColor} · modules ` +
        `${[created.moduleBooking ? 'booking' : null, created.moduleShop ? 'shop' : null]
          .filter(Boolean)
          .join(', ') || 'none'}`,
      source: 'owner_console',
      subjectType: 'salon',
      subjectId: created.id,
      metadata: {
        plan: created.plan,
        city: created.city,
        brandColor: created.brandColor,
        depositFils: created.depositFils,
        loyaltyMode: input.loyalty.mode,
        modules: { booking: created.moduleBooking, shop: created.moduleShop },
        firstBranchId: firstBranch.id,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    await writeAudit(tx, ctx.principal, {
      salonId: created.id,
      kind: 'access',
      action: 'Owner account invited',
      // Names who and when. NEVER the token — an audit row is read by more people
      // than the endpoint's response is (`routes/staff.ts`, same sentence).
      detail:
        `${owner.name} (@${owner.handle}) as owner — WhatsApp invite queued to ` +
        `${created.ownerPhone}, link valid for ${INVITE_TTL_MINUTES} minutes`,
      source: 'owner_console',
      subjectType: 'staff_user',
      subjectId: owner.id,
      metadata: {
        expiresAt: expiresAt.toISOString(),
        ttlMinutes: INVITE_TTL_MINUTES,
        channel: 'whatsapp',
        delivered: false,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    const response: OnboardResult = {
      status: 201,
      body: {
        /**
         * AN ENVELOPE, not the entity with extra keys on it.
         *
         * `POST /v1/platform/admins` answers the bare entity and this one cannot:
         * three facts came out of this write, and only one of them is a Salon.
         * Folding `owner` and `invite` in at the top level would put keys on a
         * shape clients parse through `SalonSchema`, which strips what it does not
         * declare — so the invite would vanish silently in exactly the client that
         * validates its input. Lane C already lost a Settings section to a write
         * response that was not the shape it looked like.
         */
        salon: serialiseSalon(created, [firstBranch]),
        owner: {
          staffId: owner.id,
          name: owner.name,
          handle: `@${owner.handle}`,
          role: owner.role,
          /** #6. Never the hash, never a hint, never a temporary password. */
          passwordSet: false,
        },
        invite: {
          channel: 'whatsapp',
          to: created.ownerPhone ?? input.ownerPhone,
          expiresAt: expiresAt.toISOString(),
          /**
           * FALSE, and honestly so. No sender is wired — the WhatsApp templates
           * are unapproved and the sending domain is an open client decision. The
           * console must not print "invite sent" for a message nothing will pick
           * up; `POST /staff/{id}/password-reset` returns the same field for the
           * same reason.
           */
          delivered: false,
        },
      },
    };

    await completeKey(tx, keyId, response);
    return response;
  });
}
