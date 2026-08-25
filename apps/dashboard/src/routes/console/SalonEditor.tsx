import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { fils, formatFils, moneyAriaLabel, percentOf, type Tier } from '@avo/types';
import { Button, Card, ErrorState, Money, Segmented, Skeleton, Stepper, Toggle } from '@avo/ui';
import {
  isCompleteLadder,
  LOYALTY_LABEL,
  PLAN_LABEL,
  useAllPlatformSalons,
  usePlatformSalon,
  useUpdatePlatformSalon,
  type LoyaltyMode,
  type PlatformSalonPatch,
  type PlatformSalonRecord,
} from '../../api/platformSalons.js';
import { DEPOSIT_MAX_FILS, DEPOSIT_MIN_FILS, DEPOSIT_STEP_FILS } from '../../api/platformConsole.js';
import { TIER_LABEL, TIER_LADDER, type LadderTierName } from '../../api/loyalty.js';
import { ApiError } from '../../api/client.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Console → Salons → one salon. `GET`/`PATCH /v1/platform/salons/:id`, both gated
 * `salons` (platformConsole.ts:340, :351).
 *
 * `AVO Owner Console.dc.html:400` § "salon editor" — the second half of a section
 * the design describes as "list → per-salon editor". `Salons.tsx` is the first.
 *
 * =========================================================================
 * THIS SCREEN IS THE ANSWER TO A BLOCKER, WHICH IS WORTH SAYING ONCE
 * =========================================================================
 * It was not built for weeks because no endpoint could read or write one salon,
 * and three files in this lane carried a driven 404 proving it. `4cc03c5` built
 * both routes; the 404 became false and nothing noticed for a while. The lesson is
 * already written up in `api/platformSalons.ts` § THE BLOCKER THESE REPLACE and in
 * `shell/consoleNavGates.test.ts`; it is not restated here beyond the pointer.
 *
 * =========================================================================
 * WHAT THE DESIGN DRAWS THAT THIS DOES NOT, AND WHY EACH ONE IS ABSENT
 * =========================================================================
 * Three of them, and the three reasons are genuinely different — which is the
 * point of listing them rather than writing "some controls are missing".
 *
 *   THE LIVE / SUSPENDED TOGGLE — no column. `salon` has no live or suspended
 *   field, so there is nothing to read and nothing to write. The design's header
 *   draws a switch and the words "Live" / "Suspended", and the banner one screen
 *   up promises "flip it off to instantly suspend it". Both are absent here rather
 *   than pinned to `true`: a switch that always says Live, on a product that
 *   cannot suspend a salon, is a control that lies when it is most consequential.
 *   STILL BLOCKED, and it is a schema change rather than a lane C one.
 *
 *   THE PLAN — read-only, and the server agrees. `plan` is in NEITHER
 *   `MERCHANT_EDITABLE` nor `PLATFORM_EDITABLE` (routes/salons.ts:144), on the
 *   handler's stated reasoning: it prices the account, the design puts per-salon
 *   plan and fee in BILLING, and Billing has no API at all. So the header renders
 *   it as the design does — as a fact in a subtitle, not as a control.
 *
 *   BRANCHES — READ-ONLY, and this one is an authority wall rather than a missing
 *   field. The design draws a remove ✕ per branch and an "+ Add branch" row. The
 *   three branch routes exist and always did, but every one of them is
 *   `requireDashboardPerm(req, 'loyalty')` (routes/salons.ts:640, :700, :760) —
 *   which resolves through `requireStaff(req, 'dashboard')`, and a platform admin
 *   is not staff of any salon. No console credential can satisfy it, whatever
 *   sections she holds. `serialiseSalon` DOES send the branches, so they are drawn
 *   and named with their ids, and the two controls the design puts on them are
 *   not. Reported to trunk as a console gap: either the console gets its own
 *   branch routes under `salons`, or the design's editor drops those controls.
 *
 * =========================================================================
 * ONE DRAFT AND ONE SAVE, WHICH DIVERGES FROM `Controls` ON PURPOSE
 * =========================================================================
 * `Controls.tsx` splits its writes: the flags apply on click ("a boolean has no
 * intermediate value to pass through"), the fees are drafted behind an explicit
 * Save. This screen drafts EVERYTHING, module switches included, and the reason is
 * that the two screens are not writing through the same door.
 *
 * `PATCH /v1/platform/salons/:id` writes ONE audit row per request, and its detail
 * line is literally the list of keys the request carried:
 *
 *     detail: `Changed by AVO: ${keys.join(', ')}`
 *
 * So a batched save produces "Changed by AVO: modules, depositFils, tiers" — one
 * row for one intended change, which is what somebody scanning the salon's audit
 * log for "who turned Shop on" actually wants. Applying each control on click
 * produces three rows that have to be reassembled by timestamp, and it does it on
 * a route with no idempotency key.
 *
 * The tier ladder settles it on its own. `Loyalty.tsx` established the rule for
 * this exact data — "the draft lives in component state and is never written to
 * the cache" — because stepping Gold from 10 to 14 visits would otherwise fire
 * four writes and leave the salon on three ladders nobody chose along the way.
 * The console's editor steps the same ladder through the same validator.
 *
 * THE DRAFT IS REBUILT WHENEVER THE SERVER'S ROW CHANGES UNDERNEATH IT — the
 * `key` on `<EditorForm>`, which is `Controls`' pattern. That is the answer to the
 * lost update this endpoint's own comment names: it takes no idempotency key, so a
 * retry or a concurrent admin CAN overwrite an edit. What the screen guarantees is
 * narrower and is the part a client can honour — it never displays a local edit as
 * though it had been saved.
 *
 * `Controls` keys on `settings.updatedAt`. `serialiseSalon` emits no `updatedAt`,
 * so the key here is a digest of the editable fields themselves. That is the same
 * guarantee with one extra property: a background refetch returning identical JSON
 * does not remount, so it cannot wipe a draft somebody is halfway through.
 */
export function SalonEditor() {
  /*
   * `/console/console/salons/$id`, AND THE DOUBLED SEGMENT IS NOT A TYPO.
   *
   * `from` takes a route ID, not a URL. TanStack builds a route's ID as its
   * parent's ID plus its own `path`, and the console's layout route is pathless
   * with `id: 'console'` while every child under it declares the full
   * `/console/…` path — so the ID picks the prefix up twice and the URL does not.
   * The URL this screen answers is `/console/salons/SAL-AMARA`, which is what the
   * `Link` on the list points at and what the router matches.
   *
   * The merchant tree does not have this shape because its children are declared
   * as `/overview` rather than `/merchant/overview`. Left alone rather than
   * "fixed": renaming the console's layout id would rewrite the ID of all seven
   * existing console routes for a cosmetic gain in one string.
   */
  const { id } = useParams({ from: '/console/console/salons/$id' });
  const detail = usePlatformSalon(id);
  const update = useUpdatePlatformSalon(id);

  /*
   * THE MEMBER COUNT IS NOT ON THE DETAIL ENDPOINT, and the design's header wants
   * it: "{city} · {plan} plan · {n} members". `serialiseSalon` carries no
   * `memberCount` — only the LIST does, where the handler counts it per row.
   *
   * So it is read from the list, which this admin can always reach (same `salons`
   * gate as this screen) and which is usually already in cache because she got
   * here by clicking a row. `useAllPlatformSalons` walks the cursor to the end
   * rather than trusting page one: the clause has to be right or absent, and
   * "found on page 1" is not a property of a salon.
   *
   * WHEN IT IS ABSENT THE CLAUSE IS DROPPED, not rendered as "— members" or as a
   * zero. A count is a fact about a salon's books; a placeholder in its place is
   * the fabricated-zero defect wearing a dash. See `subtitle` below.
   *
   * REPORTED: `memberCount` on the detail route would remove this whole paragraph
   * and a list walk with it.
   */
  const all = useAllPlatformSalons();

  /*
   * EVERY HOOK THIS COMPONENT OWNS IS ABOVE THIS LINE, and the error paths below
   * return early. `Salons.tsx` took the whole console to its error boundary once
   * with "Rendered fewer hooks than expected" because a `useMemo` had drifted
   * below an error return — the happy render ran three hooks and the error render
   * ran two, so the first request to actually FAIL was the one that crashed. Found
   * by killing the API and reloading, not by reading the file.
   *
   * Nothing conditional is called from here down. The draft's `useState` lives in
   * `<EditorForm>`, which is a child precisely so it can be mounted conditionally.
   */
  const record = detail.data?.salon;

  if (detail.isError) {
    /*
     * A 404 IS NOT "WE FAILED" AND IT IS NOT "YOU CAN'T", so it does not go
     * through `SectionError` — which would answer a bad salon id with "Something
     * went wrong on our side. Nothing has changed in your salon." Two things wrong
     * with that sentence here at once: nothing went wrong, and a platform admin
     * has no salon of her own for it to be talking about.
     *
     * It is reachable without anybody making a mistake: a bookmarked editor URL
     * for a salon, an id pasted from a support ticket. The server's own copy is
     * "No such salon." and it is rendered verbatim, with no retry — the same
     * reasoning `sectionState.tsx` gives for a 403. Retrying will not make the
     * salon exist.
     *
     * `api/retryPolicy.ts` was changed for this screen as well, and the two go
     * together: the policy used to spend its budget on a 404 because no read in
     * this dashboard could produce one, so the sentence below arrived only after
     * two attempts and a backoff. This route is the first read that can 404.
     *
     * Narrowed through a local binding rather than a cast — `notFound` as a plain
     * boolean does not narrow `detail.error` for the `body` below, and reaching for
     * `as ApiError` to paper over that is how a type stops meaning anything.
     */
    const failure = detail.error instanceof ApiError ? detail.error : null;
    return (
      <div className="saloned">
        <BackLink />
        {failure?.status === 404 ? (
          <ErrorState title="That salon isn’t on AVO" body={failure.message} />
        ) : (
          <SectionError
            error={detail.error}
            forbiddenTitle="You don't have access to salons"
            failedTitle="Couldn't load this salon"
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        )}
      </div>
    );
  }

  return (
    <div className="saloned">
      <BackLink />

      {detail.isPending || !record ? (
        <EditorSkeleton />
      ) : (
        <>
          <SalonHead
            record={record}
            memberCount={memberCountFor(record.id, all)}
          />
          <EditorForm
            /*
             * REMOUNTS ON A NEW SERVER ROW. See the header § ONE DRAFT AND ONE
             * SAVE — this is what makes "the draft is rebuilt from the new truth"
             * true rather than aspirational, because `useState` initialisers only
             * run on mount.
             */
            key={serverDigest(record)}
            record={record}
            busy={update.isPending}
            onSave={(patch) => update.mutate(patch)}
          />
        </>
      )}

      {update.isError ? (
        /*
         * EXACT, not reassuring-sounding. The handler does the UPDATE and its
         * audit row in one transaction, so a failure leaves the row exactly as it
         * was — and the draft on screen is still what she typed. Saying which is
         * which is the whole job of this banner (`sectionState.tsx` § WriteError).
         */
        <WriteError error={update.error} reassurance="Nothing changed for this salon." />
      ) : null}
    </div>
  );
}

/** "‹ All salons", verbatim, and a real link rather than the design's button. */
function BackLink() {
  return (
    <Link to="/console/salons" className="saloned__back">
      <span aria-hidden="true">‹</span> All salons
    </Link>
  );
}

/**
 * The count for this salon out of the walked list, or null.
 *
 * NULL WHILE THE WALK IS INCOMPLETE, and null if the walk failed. A salon that is
 * genuinely absent from a COMPLETE list is also null — that would mean the detail
 * route served a salon the list does not, which is a server disagreement this
 * screen is not the place to paper over with a number.
 */
function memberCountFor(
  id: string,
  all: ReturnType<typeof useAllPlatformSalons>,
): number | null {
  if (!all.complete) return null;
  return all.salons.find((s) => s.id === id)?.memberCount ?? null;
}

/* ------------------------------------------------------------------- header */

function SalonHead({
  record,
  memberCount,
}: {
  record: PlatformSalonRecord;
  memberCount: number | null;
}) {
  /*
   * "Salmiya · Growth plan · 1,284 members" — the design's separator and word
   * order. Each clause is dropped rather than filled when its fact is missing:
   * a salon predating migration 0037 has no city, and the member count may not
   * have arrived (see the hook's note). "— · Growth plan · — members" would be
   * three facts claimed and none held.
   */
  const parts = [
    record.city,
    `${PLAN_LABEL[record.plan]} plan`,
    memberCount === null ? null : `${memberCount.toLocaleString('en-US')} members`,
  ].filter((p): p is string => p !== null);

  return (
    <div className="saloned__head">
      <span className="saloned__initial" aria-hidden="true">
        {/* `Array.from`, not `[0]` — an Arabic first character is two code units. */}
        {Array.from(record.name)[0] ?? ''}
      </span>
      <div className="saloned__headtext">
        <h2 className="saloned__name avo-display">{record.name}</h2>
        <p className="saloned__sub">{parts.join(' · ')}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- draft */

interface Draft {
  booking: boolean;
  shop: boolean;
  /** Integer fils. Never a KD float — non-negotiable #1. */
  depositFils: number;
  mode: LoyaltyMode;
  /**
   * NULL MEANS THE SALON HAS NO STORED LADDER, and it is never replaced with an
   * invented one. `DEFAULT_LOYALTY` lives in `api/src/services/salonOnboarding.ts`
   * and every salon the wizard creates gets a full ladder from it whichever
   * mechanic it starts on — so this is the legacy-row case, not the normal one.
   * Copying those four rungs into the client would put a server default in a
   * second place, and the console would then quietly publish a ladder AVO's
   * onboarding defaults happened to hold on the day this file was written.
   */
  tiers: Tier[] | null;
  /** Same, for the stamp card. Kept across a spell in tiers mode by the server. */
  stampTarget: number | null;
}

function toDraft(r: PlatformSalonRecord): Draft {
  return {
    booking: r.modules.booking,
    shop: r.modules.shop,
    depositFils: r.depositFils,
    mode: r.loyaltyMode,
    tiers: r.tiers === null ? null : r.tiers.map((t) => ({ ...t })),
    stampTarget: r.stampTarget,
  };
}

/** The remount key. Only the fields this screen can change are in it. */
function serverDigest(r: PlatformSalonRecord): string {
  return JSON.stringify(toDraft(r));
}

/**
 * The rung's problem in the server's own terms, or null.
 *
 * MIRRORS `services/loyaltyRules.ts` RATHER THAN REPLACING IT. The server is the
 * control and refuses an invalid ladder with `threshold_not_above_tier_below`
 * whatever this says; this exists so an admin sees the problem beside the rung she
 * moved instead of as a banner after a round trip. The copy is the design's own
 * warning string, which the API's comment also quotes verbatim.
 *
 * BRONZE IS NOT CHECKED because Bronze is not editable — see `TierRow`. The server
 * locks it at 0 visits and 0 bonus (`bronze_is_locked`) and the draft is seeded
 * from a ladder that already satisfies that.
 */
function tierProblem(tiers: Tier[], index: number): string | null {
  const rung = tiers[index];
  if (!rung || index === 0) return null;
  const below = tiers[index - 1];
  if (below && rung.minVisits <= below.minVisits) {
    return `Must be more visits than ${TIER_LABEL[below.name as LadderTierName]}`;
  }
  return null;
}

/* --------------------------------------------------------------------- form */

function EditorForm({
  record,
  busy,
  onSave,
}: {
  record: PlatformSalonRecord;
  busy: boolean;
  onSave: (patch: PlatformSalonPatch) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(record));
  const server = toDraft(record);

  /*
   * A LADDER IS EDITABLE ONLY IF THE API WOULD TAKE IT BACK — see
   * `isCompleteLadder`, and § A SHORT LADDER below. `SAL-LUMIERE` ships from a
   * plain seed with two rungs, so this is a real row and not a hypothetical.
   */
  const editableLadder = isCompleteLadder(draft.tiers) ? draft.tiers : null;
  const problems = (editableLadder ?? []).map((_, i) => tierProblem(editableLadder!, i));
  const tiersInvalid = problems.some((p) => p !== null);

  /*
   * ==================== WHAT ACTUALLY BLOCKS A SAVE ====================
   * Only a change the server would refuse — and that is NARROWER than "this salon's
   * loyalty configuration is unusable", which is what this guard said first.
   *
   * THE OVER-BLOCK, AND HOW IT WAS FOUND. The first version disabled Save whenever
   * the active mechanic had nothing behind it, so `SAL-LUMIERE` — tiers mode, a
   * two-rung legacy ladder — could not have its DEPOSIT changed. Opening the real
   * screen showed a disabled Save above two perfectly editable controls. Driven
   * against the endpoint, both halves:
   *
   *   PATCH {"depositFils":6000}        on the 2-rung salon   →  200
   *   PATCH {"loyaltyMode":"tiers"}     on the 2-rung salon   →  200   (already tiers)
   *
   * `services/loyaltyRules.ts` says exactly why, and this guard is now its mirror:
   * a stored ladder is revalidated only when a request PUTS IT INTO EFFECT —
   * `activatesStoredTiers = !suppliesTiers && current.mode !== 'tiers'`. A request
   * that leaves the mechanic alone passes the ladder through untouched, whatever
   * shape it is in. That narrowing exists on the server because the strict version
   * locked such a salon out of editing anything at all; copying the strict version
   * into the client would have reintroduced the same lockout one layer up.
   *
   * So: the tier CONTROLS are read-only whenever the ladder is not four rungs
   * (`editableLadder === null`, above), and the SAVE is blocked only when the draft
   * would switch the mechanic ONTO a side that has nothing behind it.
   */
  const activatesLadder = draft.mode === 'tiers' && server.mode !== 'tiers';
  const unusableLadder = activatesLadder && editableLadder === null;
  /*
   * The mirror for stamps. It can only fire on a switch: `salon_loyalty_config_complete`
   * guarantees a salon already in stamps mode has a target, so a null one here means
   * the draft is moving onto the empty side.
   */
  const missingCard = draft.mode === 'stamps' && draft.stampTarget === null;
  const invalid = tiersInvalid || unusableLadder || missingCard;

  const dirty = JSON.stringify(draft) !== JSON.stringify(server);

  /**
   * ONLY THE CHANGED FIELDS, which is `Controls`' rule and for its second reason
   * as well as its first: it narrows the lost-update window. An admin who only
   * turned Shop on does not also overwrite another admin's tier edit with the
   * ladder her screen happened to load.
   *
   * `modules` is sent as the PAIR because that is the wire shape the API defines
   * and `applyModules` splits it into two columns. The COLUMN spellings
   * (`moduleBooking` / `moduleShop`) are deliberately refused by the server — two
   * doors into one field is how the tier ladder acquired an unvalidated second
   * entrance, and the console's copy would be the one nobody was watching.
   *
   * THE LOYALTY FIELDS GO TOGETHER OR NOT AT ALL. `parseLoyaltyConfig` validates
   * the WHOLE configuration whenever any loyalty key is present, filling what the
   * request omits from the stored row — so sending `tiers` without `loyaltyMode`
   * is safe, and sending a mode switch without the side it activates is the 400
   * the guards above prevent.
   */
  function save() {
    const patch: PlatformSalonPatch = {};
    if (draft.booking !== server.booking || draft.shop !== server.shop) {
      patch.modules = { booking: draft.booking, shop: draft.shop };
    }
    if (draft.depositFils !== server.depositFils) patch.depositFils = draft.depositFils;
    if (draft.mode !== server.mode) patch.loyaltyMode = draft.mode;
    /*
     * A SHORT LADDER IS NEVER SENT. `parseTiers` refuses anything but four rungs
     * ("Got 2."), so forwarding a stored two-rung ladder unchanged would turn a
     * deposit edit into a 400 about tiers the admin never touched — which is the
     * precise failure `services/loyaltyRules.ts` narrowed its own rule to avoid.
     * It cannot be edited either, so it cannot have changed.
     */
    if (editableLadder !== null && JSON.stringify(editableLadder) !== JSON.stringify(server.tiers)) {
      patch.tiers = editableLadder;
    }
    if (draft.stampTarget !== null && draft.stampTarget !== server.stampTarget) {
      patch.stampTarget = draft.stampTarget;
    }
    if (Object.keys(patch).length === 0) return;
    onSave(patch);
  }

  /*
   * Each sentence names the change that cannot be made, not the salon's general
   * condition — a short ladder is not a reason to tell somebody editing the deposit
   * that nothing can be saved.
   */
  const status = invalid
    ? unusableLadder
      ? draft.tiers === null
        ? 'Switching to Tiers needs a ladder, and this salon has none on record.'
        : `Switching to Tiers needs all ${TIER_LADDER.length} rungs, and this salon's ladder has ${draft.tiers.length}.`
      : missingCard
        ? 'Switching to Stamps needs a stamp card, and this salon has none on record.'
        : 'Fix the highlighted tier before saving.'
    : dirty
      ? 'Unsaved changes — this salon is still running its saved setup.'
      : 'No unsaved changes.';

  return (
    <>
      <div className="saloned__two">
        <Card className="saloned__card saloned__card--rows">
          <h3 className="saloned__cardtitle avo-display">Modules</h3>
          <ModuleRow
            name="Booking"
            body="Service → artist → slot, wallet deposit."
            on={draft.booking}
            busy={busy}
            onChange={(booking) => setDraft((d) => ({ ...d, booking }))}
          />
          <ModuleRow
            name="Shop"
            body="Flat catalog, pay from wallet."
            on={draft.shop}
            busy={busy}
            onChange={(shop) => setDraft((d) => ({ ...d, shop }))}
          />
        </Card>

        <Card className="saloned__card">
          <h3 className="saloned__cardtitle avo-display">Booking deposit</h3>
          <p className="saloned__cardsub">Held from the wallet at confirmation.</p>
          <div className="saloned__depositrow">
            <Stepper
              label="Booking deposit"
              value={draft.depositFils}
              /*
               * THE SERVER'S RANGE AND THE DESIGN'S AGREE, which is worth stating
               * because they did not have to. `parseDepositFils` refuses anything
               * outside 1000–10000 fils by name (`deposit_out_of_range`) and
               * `salon_deposit_in_range` refuses it again at the column; the design
               * writes "1–10 KD" beside the stepper. Same numbers, so the control
               * cannot express a value the endpoint would reject.
               */
              min={DEPOSIT_MIN_FILS}
              max={DEPOSIT_MAX_FILS}
              step={DEPOSIT_STEP_FILS}
              disabled={busy}
              onChange={(depositFils) => setDraft((d) => ({ ...d, depositFils }))}
              /*
               * A WHOLE KD PER PRESS, IN FILS. The value is never divided into a KD
               * float; `Money` formats it at the display boundary, which is the one
               * place a decimal point exists. The design's stepper shows "5"; this
               * shows "5.000", the same number through the one money formatter.
               */
              format={(v) => (
                <>
                  <span className="saloned__depositnum avo-display">
                    <Money amount={fils(v)} />
                  </span>
                  <span className="saloned__depositunit">KD</span>
                </>
              )}
              /*
               * Without this the spinbutton announces "five thousand": `aria-valuenow`
               * is the raw fils integer, because that is what the control steps.
               * interaction-spec.md §2 requires money to read as dinars.
               */
              valueText={moneyAriaLabel(fils(draft.depositFils))}
            />
            <span className="saloned__depositrange">1&ndash;10 KD</span>
          </div>
        </Card>
      </div>

      <Card className="saloned__card">
        <div className="saloned__loyaltyhead">
          <div>
            <h3 className="saloned__cardtitle avo-display">Loyalty structure</h3>
            <p className="saloned__cardsub">
              Set this salon&rsquo;s reward mechanic and tune every threshold.
            </p>
          </div>
          <Segmented
            label="Loyalty mechanic"
            value={draft.mode}
            onChange={(mode) => setDraft((d) => ({ ...d, mode }))}
            options={[
              { value: 'tiers', label: LOYALTY_LABEL.tiers },
              { value: 'stamps', label: LOYALTY_LABEL.stamps },
            ]}
          />
        </div>

        {draft.mode === 'tiers' ? (
          editableLadder === null ? (
            /*
             * ======================= A SHORT LADDER =======================
             * Two dead ends that look alike on screen and are different underneath,
             * so they get different sentences.
             *
             * NO LADDER AT ALL — nothing to draw. The client does not invent one:
             * `DEFAULT_LOYALTY` is a SERVER default (`services/salonOnboarding.ts`),
             * and copying its four rungs here would let the console publish whatever
             * AVO's onboarding happened to default to on the day this was written.
             *
             * A LADDER WITH FEWER THAN FOUR RUNGS — real, seeded, and live. It is
             * SHOWN, read-only, because the salon is running it and hiding it would
             * be the worse lie; and it is not editable, because `parseTiers` refuses
             * to take back anything but four rungs. Repairing it belongs to
             * `PUT /salons/{id}/loyalty`, the endpoint that owns publishing, on the
             * salon's own dashboard.
             */
            <>
              <p className="saloned__notice" role="note">
                {draft.tiers === null
                  ? 'This salon has no tier ladder on record, so there is nothing to tune here. Its own dashboard publishes one from Loyalty.'
                  : `This salon is running a ${draft.tiers.length}-rung ladder from before the ladder was fixed at ${TIER_LADDER.length}. AVO can see it but not edit it — its own dashboard republishes it from Loyalty.`}
              </p>
              {draft.tiers !== null && draft.tiers.length > 0 ? (
                <ul className="saloned__stored">
                  {draft.tiers.map((tier) => (
                    <li key={tier.name} className="saloned__storedrung">
                      <span
                        className="saloned__tierdot"
                        data-tier={tier.name}
                        aria-hidden="true"
                      />
                      <span className="avo-display">{TIER_LABEL[tier.name as LadderTierName]}</span>
                      <span className="saloned__storedvalue">
                        {tier.minVisits} visits · +{tier.bonusPercent}%
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <TierTable
              tiers={editableLadder}
              problems={problems}
              busy={busy}
              onChange={(index, patch) =>
                setDraft((d) => ({
                  ...d,
                  tiers: (d.tiers ?? []).map((t, i) => (i === index ? { ...t, ...patch } : t)),
                }))
              }
            />
          )
        ) : draft.stampTarget === null ? (
          <p className="saloned__notice" role="note">
            This salon has no stamp card on record, so it cannot be switched to Stamps here.
            Its own dashboard publishes one from Loyalty.
          </p>
        ) : (
          <StampPanel
            target={draft.stampTarget}
            busy={busy}
            onChange={(stampTarget) => setDraft((d) => ({ ...d, stampTarget }))}
          />
        )}
      </Card>

      <BranchesCard record={record} />

      <div className="saloned__save">
        <span className="saloned__status" role="status" data-dirty={dirty || invalid ? '' : undefined}>
          {status}
        </span>
        <Button disabled={busy || invalid || !dirty} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ modules */

function ModuleRow({
  name,
  body,
  on,
  busy,
  onChange,
}: {
  name: string;
  body: string;
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="saloned__row">
      <div>
        <div className="saloned__rowname">{name}</div>
        <div className="saloned__rowbody">{body}</div>
      </div>
      {/*
        WRITABLE HERE, AND `Settings.tsx` SAYS THE OPPOSITE ABOUT THE SAME FIELD.
        That screen disables its module toggles under "the workspace has no
        endpoint for it", which was true when written and stopped being true at
        `e883330` — `modules` has been in `MERCHANT_EDITABLE` since
        (routes/salons.ts:57, with its own comment on the wire shape). The console
        route reaches the same field through the same translator, so it is enabled
        here. The merchant screen's stale notice is reported separately rather than
        edited from this slice.
      */}
      <Toggle checked={on} disabled={busy} onChange={onChange} label={`${name} module`} labelHidden />
    </div>
  );
}

/* -------------------------------------------------------------------- tiers */

function TierTable({
  tiers,
  problems,
  busy,
  onChange,
}: {
  tiers: Tier[];
  problems: Array<string | null>;
  busy: boolean;
  onChange: (index: number, patch: Partial<Tier>) => void;
}) {
  /*
   * "Example — a Silver member topping up 10.000 KD gets 11.000 KD (+10%)."
   *
   * The design's sentence and the design's own choice of rung — the first with a
   * bonus, falling back to the second. What is NOT the design's is the arithmetic:
   * it computes `(10 + bonus / 10).toFixed(1)` in floating point and prints "11.0".
   * `percentOf` is the function `services/topup.ts` uses to price a real top-up and
   * `formatFils` is the one money formatter, so the figure here is the figure that
   * would actually be credited, to three decimals. `Loyalty.tsx` settled this the
   * same way for the merchant's own ladder.
   */
  const example = tiers.find((t) => t.bonusPercent > 0) ?? tiers[1];
  const topUp = fils(10_000);

  return (
    <>
      <div className="saloned__scroll">
        <table className="saloned__tiers">
          <caption className="avo-sr-only">
            The four tier rungs, their visit thresholds and their top-up bonuses.
          </caption>
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col">Visits required</th>
              <th scope="col">Top-up bonus</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier, index) => (
              <TierRow
                key={tier.name}
                tier={tier}
                index={index}
                problem={problems[index] ?? null}
                busy={busy}
                onChange={(patch) => onChange(index, patch)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {example ? (
        <p className="saloned__example">
          Example — a {TIER_LABEL[example.name as LadderTierName]} member topping up{' '}
          {formatFils(topUp)} KD gets{' '}
          {formatFils(fils(topUp + percentOf(topUp, example.bonusPercent)))} KD (+
          {example.bonusPercent}%).
        </p>
      ) : null}
    </>
  );
}

/** The design's clamps for the two steppers. `AVO Owner Console.dc.html:1327`. */
const VISITS_MAX = 60;
const BONUS_MAX = 50;

function TierRow({
  tier,
  index,
  problem,
  busy,
  onChange,
}: {
  tier: Tier;
  index: number;
  problem: string | null;
  busy: boolean;
  onChange: (patch: Partial<Tier>) => void;
}) {
  const locked = index === 0;
  const label = TIER_LABEL[tier.name as LadderTierName];

  return (
    <tr data-bad={problem ? '' : undefined}>
      <th scope="row" className="saloned__tiername">
        <span className="saloned__tierdot" data-tier={tier.name} aria-hidden="true" />
        <span className="avo-display">{label}</span>
      </th>
      {locked ? (
        /*
         * BRONZE IS THE FLOOR: 0 visits, 0 bonus, and the API refuses anything else
         * with `bronze_is_locked` ("Bronze carries no bonus. Set the bonus on Silver
         * and above."). The design draws live steppers on it; they cannot be wired
         * to anything the server would accept.
         *
         * Rendered as words rather than as disabled steppers, which is the ruling
         * `Loyalty.tsx` already made for the same rung: "a disabled input invites a
         * merchant to wonder what unlocks it."
         */
        <td colSpan={2} className="saloned__tierlocked">
          Everyone starts here · no bonus · not editable
        </td>
      ) : (
        <>
          <td>
            <Stepper
              size="sm"
              label={`${label} visits required`}
              value={tier.minVisits}
              min={0}
              max={VISITS_MAX}
              step={1}
              disabled={busy}
              onChange={(minVisits) => onChange({ minVisits })}
              format={(v) => <span className="avo-display">{v}</span>}
              valueText={`${tier.minVisits} visits`}
            />
          </td>
          <td>
            <Stepper
              size="sm"
              label={`${label} top-up bonus`}
              value={tier.bonusPercent}
              min={0}
              /*
               * The design clamps at 50 and `TierSchema` allows up to 100. The
               * DESIGN'S clamp is used, because it is the drawn control and a
               * console that can hand a salon a 90% top-up bonus in two dozen
               * clicks is a money control with no ceiling anybody chose. The
               * server's 100 remains the enforcement.
               */
              max={BONUS_MAX}
              step={1}
              disabled={busy}
              onChange={(bonusPercent) => onChange({ bonusPercent })}
              format={(v) => <span className="saloned__bonus avo-display">+{v}%</span>}
              valueText={`plus ${tier.bonusPercent} percent`}
            />
            {problem ? <div className="saloned__tierwarn">{problem}</div> : null}
          </td>
        </>
      )}
    </tr>
  );
}

/* ------------------------------------------------------------------- stamps */

function StampPanel({
  target,
  busy,
  onChange,
}: {
  target: number;
  busy: boolean;
  onChange: (next: number) => void;
}) {
  /*
   * THE DESIGN CLAMPS 4–12 AND THE SERVER ACCEPTS 1–50, so a stored target can sit
   * outside the drawn control's range — `seed.ts` and the wizard both use 8, but a
   * salon set to 3 through the merchant's own Loyalty screen is a real row.
   *
   * The bounds WIDEN to include whatever is stored rather than clamping it. A
   * stepper rendered with `value` below its `min` would pull the number into range
   * on the first press and save a change the admin did not ask for — a silent edit,
   * which is worse than a control that stretches.
   */
  const min = Math.min(4, target);
  const max = Math.max(12, target);

  return (
    <div className="saloned__stamps">
      <div>
        <p className="saloned__cardsub">Stamps to earn a free service</p>
        <Stepper
          label="Stamps to earn a free service"
          value={target}
          min={min}
          max={max}
          step={1}
          disabled={busy}
          onChange={onChange}
          format={(v) => <span className="saloned__stampnum avo-display">{v}</span>}
          valueText={`${target} stamps`}
        />
      </div>
      {/*
        The design's card of dots, drawn EMPTY. Its prototype fills the first three
        ("i < 3 ? '#6E7F6C' : 'transparent'") because it is showing a specimen
        customer; this is a salon-wide setting and there is no member in view. Three
        filled dots here would be a stamp count belonging to nobody.
      */}
      <ul className="saloned__dots" aria-hidden="true">
        {Array.from({ length: target }, (_, i) => (
          <li key={i} className="saloned__dot" />
        ))}
      </ul>
      <p className="saloned__example saloned__example--stamps">
        One stamp per visit or shop purchase · no top-up bonus in stamps mode.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- branches */

function BranchesCard({ record }: { record: PlatformSalonRecord }) {
  return (
    <Card className="saloned__card">
      <h3 className="saloned__cardtitle avo-display">Branches</h3>
      <p className="saloned__cardsub">
        One wallet across all. Each branch gets an ID staff can be scoped to.
      </p>

      {/*
        READ-ONLY, AND THE REASON IS AN AUTHORITY WALL RATHER THAN A MISSING ROUTE
        — see the screen header. The design draws a ✕ per branch and an "+ Add
        branch" row; all three branch endpoints are `requireDashboardPerm(…,
        'loyalty')`, which no console credential can satisfy. Stating it is the
        difference between a known boundary and a screen that looks half-finished.
      */}
      <p className="saloned__notice" role="note">
        Branches are opened and closed from the salon&rsquo;s own dashboard. AVO can see them
        here but not change them.
      </p>

      {record.branches.length === 0 ? (
        /*
         * A real empty, and it names the thing (interaction-spec.md §4). Not
         * `EmptyState`: that block is a section-sized answer with its own heading,
         * and this is one line inside a card that has already named itself.
         */
        <p className="saloned__branchempty">
          No open branches. A salon&rsquo;s first branch is created with it.
        </p>
      ) : (
        <ul className="saloned__branches">
          {record.branches.map((branch) => (
            <li key={branch.id} className="saloned__branch">
              <span className="saloned__branchdot" aria-hidden="true" />
              <span className="saloned__branchname">{branch.name}</span>
              <span className="saloned__branchid avo-display">{branch.id}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ loading */

/**
 * interaction-spec.md §4: the skeleton matches the loaded layout's shape, and the
 * deposit skeletons as a BAR. A stepper showing "0.000 KD" before the row arrives
 * is a deposit somebody could read as this salon's — the fabricated-zero rule, on
 * the field where it is money.
 */
function EditorSkeleton() {
  return (
    <>
      <div className="saloned__head">
        <Skeleton width={52} height={52} radius={15} />
        <div className="saloned__headtext">
          <Skeleton width={180} height={24} />
          <Skeleton width={240} height={13} />
        </div>
      </div>

      <div className="saloned__two">
        <Card className="saloned__card saloned__card--rows">
          <h3 className="saloned__cardtitle avo-display">Modules</h3>
          {[0, 1].map((i) => (
            <div className="saloned__row" key={i}>
              <div>
                <Skeleton width={70} height={14} />
                <Skeleton width="80%" height={12} />
              </div>
              <Skeleton width={44} height={26} radius={999} />
            </div>
          ))}
        </Card>
        <Card className="saloned__card">
          <h3 className="saloned__cardtitle avo-display">Booking deposit</h3>
          <p className="saloned__cardsub">Held from the wallet at confirmation.</p>
          <div className="saloned__depositrow">
            <Skeleton width={200} height={38} />
          </div>
        </Card>
      </div>

      <Card className="saloned__card">
        <h3 className="saloned__cardtitle avo-display">Loyalty structure</h3>
        <p className="saloned__cardsub">
          Set this salon&rsquo;s reward mechanic and tune every threshold.
        </p>
        {TIER_LADDER.map((name) => (
          <div className="saloned__tierskel" key={name}>
            <Skeleton width={90} height={15} />
            <Skeleton width={110} height={30} />
            <Skeleton width={110} height={30} />
          </div>
        ))}
      </Card>
    </>
  );
}
