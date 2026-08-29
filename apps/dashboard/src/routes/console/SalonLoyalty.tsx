import { useState } from 'react';
import { fils, formatFils, type Tier } from '@avo/types';
import { Button, Card, Segmented, Skeleton, Stepper } from '@avo/ui';
import {
  TIER_LABEL,
  TIER_LADDER,
  usePlatformLoyalty,
  usePublishPlatformLoyalty,
  type LadderTierName,
  type LoyaltyConfig,
  type LoyaltyPublish,
  type PublishedLoyalty,
  type TierPreview,
} from '../../api/loyalty.js';
import { isCompleteLadder, LOYALTY_LABEL } from '../../api/platformSalons.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Console → Salons → one salon → **Loyalty**. `GET`/`PUT /salons/{id}/loyalty`,
 * both `sections.salons` for a platform principal.
 *
 * ==========================================================================
 * THE CAPABILITY THE MERCHANT LOST, REBUILT WHERE IT NOW LIVES.
 * ==========================================================================
 * Aftab: *"Owner console will control the loyalty part not the merchant (it will
 * be read only for merchant)."* `routes/Loyalty.tsx` is the withdrawal; this is
 * the other half. `api/src/routes/loyalty.ts` carries the server-side argument,
 * including why the gate is `sections.salons` and not `analytics` (every console
 * role preset holds `analytics`, `analyst` included, and an analyst is "read-only
 * metrics" — publishing a ladder decides what a top-up is worth).
 *
 * ==========================================================================
 * WHY IT IS INSIDE `SalonEditor` AND WHY IT IS NOT INSIDE `SalonEditor.tsx`
 * ==========================================================================
 * Those are two different questions and they have opposite answers.
 *
 * ONE SCREEN. It renders as a card in the per-salon editor, not as a second
 * destination. The console already navigates salon → editor, `consoleNavItems`
 * subtitles the section "Open a salon to edit its setup and loyalty", and the
 * design's own § "salon editor" draws modules, deposit, loyalty and branches as
 * one page. A separate `/console/salons/$id/loyalty` route would split one salon's
 * settings across two URLs so that one card could have its own button.
 *
 * ONE FILE OF ITS OWN, because it is a SECOND WRITE PATH with a second lifecycle:
 * its own query, its own mutation, its own draft, its own failure. `SalonEditor`'s
 * header explains that it batches every control behind one Save specifically
 * because `PATCH /v1/platform/salons/{id}` writes one audit row per request whose
 * detail is the list of keys sent — "Changed by AVO: modules, depositFils" is one
 * row for one intended change. That reasoning is about fields travelling through
 * ONE endpoint. Loyalty no longer does.
 *
 * ==========================================================================
 * AND WHY IT PUBLISHES THROUGH `PUT`, WHEN `PATCH` WOULD ALSO HAVE WORKED
 * ==========================================================================
 * This is the part worth being explicit about, because the easy path was to
 * change nothing: the console's `PATCH` still accepts `loyaltyMode`, `tiers` and
 * `stampTarget` — they moved from `MERCHANT_EDITABLE` into
 * `PLATFORM_ONLY_EDITABLE` rather than out of both — and `SalonEditor` was already
 * drafting all three into its batched save. Driven on this lane's database:
 *
 *     PATCH /v1/platform/salons/SAL-AMARA {"tiers":[…4 rungs…]}   →  200
 *
 * Three reasons it moved anyway, in ascending order of weight:
 *
 *   1. TWO DOORS INTO `salon.tiers`. `routes/loyalty.ts` spends a paragraph on
 *      this: the ladder once acquired an unvalidated second entrance through
 *      `PATCH /salons/{id}` and the note there records what it cost. Both doors
 *      are validated now, but the console keeping two of them is the same shape,
 *      and "the console's copy is the one nobody would be watching".
 *
 *   2. THE AUDIT ROW IS A DIFFERENT SENTENCE. `PUT` writes `Tier rules published`
 *      with `source: 'owner_console'` against the TARGET salon — the row a
 *      merchant reads in her own audit log, which `routes/audit.ts` promises her
 *      ("AVO platform staff actions on your salon appear here too, marked **Owner
 *      console**"). `PATCH` would file the same act as `Changed by AVO: tiers`.
 *      With the merchant no longer able to publish, that log is the ONLY way she
 *      finds out why Gold moved, so which sentence lands in it stopped being
 *      cosmetic on the day the button was taken away from her.
 *
 *   3. A PUBLISH THAT HALF-APPEARS TO WORK IS WORSE HERE THAN ON HER SCREEN.
 *      The console is editing someone else's live commercial terms. `PATCH`
 *      answers with the salon row; `PUT` answers with `publishedBy`,
 *      `publishedAt`, `appliesAt: 'next_visit'` and the server's own sentence —
 *      which is the difference between a 200 and evidence. See § THE RECEIPT.
 *
 * ==========================================================================
 * WHAT THIS SCREEN CANNOT DO, STATED RATHER THAN LEFT AS A DEAD END
 * ==========================================================================
 * It cannot repair a ladder that is not exactly four rungs, and after the reversal
 * NOTHING CAN. `parseTiers` refuses to accept back anything but four; SAL-LUMIERE
 * runs a live two-rung ladder (`jsonb_array_length(tiers) = 2`, confirmed in SQL);
 * completing it means choosing thresholds and bonuses for two rungs that do not
 * exist, which is authoring commercial terms for a salon out of nothing. The
 * client will not invent them — `DEFAULT_LOYALTY` is a SERVER default in
 * `services/salonOnboarding.ts` and copying its rungs here would publish whatever
 * AVO's onboarding happened to default to on the day this file was written.
 *
 * `SalonEditor` used to say the salon's own dashboard would republish it. THAT
 * SENTENCE IS NOW FALSE and is gone: her dashboard publishes nothing. Escalated —
 * a legacy short ladder is unreachable from every surface, and closing it is a
 * console affordance for authoring a fresh ladder that nobody has designed.
 */

/** The design's clamps for the two steppers. `AVO Owner Console.dc.html:1327`. */
const VISITS_MAX = 60;
const BONUS_MAX = 50;

/** The design clamps 4–12; the server accepts 1–50. See `StampPanel`. */
const STAMPS_MIN = 4;
const STAMPS_MAX = 12;

interface Draft {
  mode: 'tiers' | 'stamps';
  /**
   * NULL MEANS THE SALON HAS NO STORED LADDER, and it is never replaced with an
   * invented one. See the header § WHAT THIS SCREEN CANNOT DO.
   */
  tiers: Tier[] | null;
  /** Same, for the stamp card. Kept across a spell in tiers mode by the server. */
  stampTarget: number | null;
}

function toDraft(config: LoyaltyConfig): Draft {
  return {
    mode: config.loyaltyMode,
    tiers: config.tiers === null ? null : config.tiers.map((t) => ({ ...t })),
    stampTarget: config.stampTarget,
  };
}

/** The remount key. Only the fields this screen can change are in it. */
function serverDigest(config: LoyaltyConfig): string {
  return JSON.stringify(toDraft(config));
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

/* ------------------------------------------------------------------ screen */

export function SalonLoyalty({ salonId }: { salonId: string }) {
  const loyalty = usePlatformLoyalty(salonId);
  const publish = usePublishPlatformLoyalty(salonId);

  if (loyalty.isError) {
    /*
     * ITS OWN ERROR ANSWER, INSIDE ITS HOST'S SCREEN — the split
     * `console/SupportQueue.tsx` already makes. Two reads against two routes fail
     * independently, and a card that borrowed the editor's banner would report a
     * loyalty outage as a salon that could not be loaded, next to a modules
     * control that is working.
     *
     * The card frame is kept around it so the section does not vanish from the
     * page; a card that disappears on failure is the blanked-screen defect.
     */
    return (
      <Card className="saloned__card">
        <h3 className="saloned__cardtitle avo-display">Loyalty structure</h3>
        <SectionError
          error={loyalty.error}
          forbiddenTitle="You don't have access to this salon's loyalty"
          failedTitle="Couldn't load this salon's loyalty rules"
          onRetry={() => void loyalty.refetch()}
          retrying={loyalty.isFetching}
        />
      </Card>
    );
  }

  return (
    <Card className="saloned__card">
      <div className="saloned__loyaltyhead">
        <div>
          <h3 className="saloned__cardtitle avo-display">Loyalty structure</h3>
          <p className="saloned__cardsub">
            Set this salon&rsquo;s reward mechanic and tune every threshold. Publishing takes
            effect for its customers immediately.
          </p>
        </div>
      </div>

      {loyalty.isPending || !loyalty.data ? (
        <LoyaltySkeleton />
      ) : (
        <PublishForm
          /*
           * REMOUNTS ON A NEW SERVER CONFIG — `SalonEditor`'s pattern, and what
           * makes "the draft is rebuilt from the new truth" true rather than
           * aspirational, because `useState` initialisers only run on mount. A
           * background refetch returning identical JSON produces an identical
           * digest and does not remount, so it cannot wipe a draft in progress.
           */
          key={serverDigest(loyalty.data)}
          config={loyalty.data}
          busy={publish.isPending}
          published={publish.data}
          onPublish={(body) => publish.mutate(body)}
        />
      )}

      {publish.isError ? (
        /*
         * EXACT, NOT REASSURING-SOUNDING, and the sentence names the salon's
         * customers rather than the request. The handler validates before the
         * transaction opens and commits the ladder with its audit row together, so
         * a failure leaves the stored ladder exactly as it was — while the draft on
         * screen is still what the admin set. Saying which is which is the whole
         * job (`sectionState.tsx` § WriteError).
         */
        <WriteError
          error={publish.error}
          reassurance="Nothing was published — this salon's customers are still on the old rules."
        />
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------- form */

function PublishForm({
  config,
  busy,
  published,
  onPublish,
}: {
  config: LoyaltyConfig;
  busy: boolean;
  published: PublishedLoyalty | undefined;
  onPublish: (body: LoyaltyPublish) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(config));
  const server = toDraft(config);

  /*
   * A LADDER IS EDITABLE ONLY IF THE API WOULD TAKE IT BACK — `isCompleteLadder`,
   * and the header § WHAT THIS SCREEN CANNOT DO. SAL-LUMIERE ships from a plain
   * seed with two rungs, so this is a real row and not a hypothetical.
   */
  const editableLadder = isCompleteLadder(draft.tiers) ? draft.tiers : null;
  /*
   * Bound to a const rather than mapped through `editableLadder!`. The
   * non-null assertion compiles and is the version this was written as first; a
   * `!` inside a closure is exactly where a narrowing that stops holding goes
   * unnoticed, and there is no reason to spend one here.
   */
  const rungs: Tier[] = editableLadder ?? [];
  const problems = rungs.map((_, i) => tierProblem(rungs, i));
  const tiersInvalid = problems.some((p) => p !== null);

  /*
   * WHAT BLOCKS A PUBLISH. Narrower than "this salon's loyalty is unusable" —
   * `PUT` validates the WHOLE configuration for the mode that will be ACTIVE and
   * leaves the other side alone, so a stamps publish is not blocked by a broken
   * ladder and vice versa. Each sentence in `status` below names the change that
   * cannot be made rather than the salon's general condition.
   */
  const unusableLadder = draft.mode === 'tiers' && editableLadder === null;
  const missingCard = draft.mode === 'stamps' && draft.stampTarget === null;
  const invalid = tiersInvalid || unusableLadder || missingCard;

  const dirty = JSON.stringify(draft) !== JSON.stringify(server);

  function submit() {
    if (invalid || !dirty) return;
    if (draft.mode === 'tiers') {
      /*
       * `editableLadder` is non-null here — `unusableLadder` is in `invalid`
       * above, so a short ladder never reaches this branch. A short ladder is
       * never SENT: `parseTiers` refuses anything but four rungs ("Got 2."), so
       * forwarding one would turn a mechanic switch into a 400 about tiers the
       * admin never touched.
       */
      onPublish({ loyaltyMode: 'tiers', tiers: editableLadder ?? [] });
      return;
    }
    onPublish({ loyaltyMode: 'stamps', stampTarget: draft.stampTarget ?? 0 });
  }

  const status = invalid
    ? unusableLadder
      ? draft.tiers === null
        ? 'This salon has no tier ladder on record, so there is nothing to publish.'
        : `This salon's ladder has ${draft.tiers.length} rungs and a ladder is published as all ${TIER_LADDER.length}.`
      : missingCard
        ? 'Switching to Stamps needs a stamp card, and this salon has none on record.'
        : 'Fix the highlighted tier before publishing.'
    : dirty
      ? 'Unsaved changes — this salon’s customers see the old rules until you publish.'
      : 'Live for this salon’s customers. Existing balances are never affected.';

  return (
    <>
      <div className="saloned__loyaltymode">
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
          <StoredLadder tiers={draft.tiers} />
        ) : (
          <TierTable
            tiers={editableLadder}
            preview={config.preview}
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
          This salon has no stamp card on record, so it cannot be switched to Stamps. AVO sets
          the target and the reward at onboarding.
        </p>
      ) : (
        <StampPanel
          target={draft.stampTarget}
          reward={config.stampReward}
          busy={busy}
          onChange={(stampTarget) => setDraft((d) => ({ ...d, stampTarget }))}
        />
      )}

      <div className="saloned__save">
        <span
          className="saloned__status"
          role="status"
          data-dirty={dirty || invalid ? '' : undefined}
        >
          {status}
        </span>
        <Button disabled={busy || invalid || !dirty} onClick={submit}>
          {busy ? 'Publishing…' : 'Publish changes'}
        </Button>
      </div>

      {/*
        ======================== THE RECEIPT ========================
        HIDDEN THE MOMENT THE DRAFT DIVERGES AGAIN, which is the only part of this
        block that needed thinking about. `publish.data` survives as long as the
        mutation does; left unconditional it would sit under a half-edited ladder
        saying "customers see them now", which is the exact reading this screen
        exists to prevent — a publish that half-appears to have happened.

        EVERY FIELD IN IT IS THE SERVER'S. The sentence is `message`, composed by
        the handler ("one place decides what the product says happened"); the name
        is `publishedBy`, which is the console account the row was audited under,
        not "AVO"; the time is `publishedAt`, the instant the transaction committed
        rather than the instant this browser rendered. `appliesAt` is rendered as
        the sentence it stands for, because "next_visit" is a wire value.
      */}
      {published && !dirty ? (
        <div className="saloned__receipt" role="status">
          <span className="saloned__receiptdot" aria-hidden="true" />
          <span>
            <b>{published.message}</b>
            <br />
            Published by {published.publishedBy} · {formatPublishedAt(published.publishedAt)} ·
            thresholds re-evaluate on each customer&rsquo;s next visit.
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * `publishedAt` is an ISO instant from the server. Rendered in the reader's own
 * locale and zone rather than the salon's: this is a record of when an AVO admin
 * acted, read by AVO admins, and the salon's business timezone is the wrong frame
 * for it. (Business hours and happy-hour windows are the opposite case and are
 * handled in the salon's zone — see `parseTimeZone` on the API side.)
 */
function formatPublishedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ------------------------------------------------------------ short ladder */

/**
 * A stored ladder the API would not take back. SHOWN, because the salon is
 * running it and hiding it would be the worse lie; not editable, because
 * `parseTiers` refuses anything but four rungs.
 *
 * Two dead ends that look alike on screen and are different underneath, so they
 * get different sentences. Neither points anywhere any more — see the header.
 */
function StoredLadder({ tiers }: { tiers: Tier[] | null }) {
  return (
    <>
      <p className="saloned__notice" role="note">
        {tiers === null
          ? 'This salon has no tier ladder on record, so there is nothing to tune here. AVO sets a ladder up when a salon is onboarded.'
          : `This salon is running a ${tiers.length}-rung ladder from before the ladder was fixed at ${TIER_LADDER.length}. It can be read here but not tuned: a ladder is published as all ${TIER_LADDER.length} rungs.`}
      </p>
      {tiers !== null && tiers.length > 0 ? (
        <ul className="saloned__stored">
          {tiers.map((tier) => (
            <li key={tier.name} className="saloned__storedrung">
              <span className="saloned__tierdot" data-tier={tier.name} aria-hidden="true" />
              <span className="avo-display">{TIER_LABEL[tier.name as LadderTierName]}</span>
              <span className="saloned__storedvalue">
                {tier.minVisits} visits · +{tier.bonusPercent}%
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------- tiers */

function TierTable({
  tiers,
  preview,
  problems,
  busy,
  onChange,
}: {
  tiers: Tier[];
  preview: TierPreview[] | null;
  problems: Array<string | null>;
  busy: boolean;
  onChange: (index: number, patch: Partial<Tier>) => void;
}) {
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
      <LadderExample tiers={tiers} preview={preview} />
    </>
  );
}

/**
 * "Example — a Silver member topping up 10.000 KD gets 11.000 KD (+10%)."
 *
 * The design's sentence and the design's own choice of rung — the first with a
 * bonus, falling back to the second. What is not the design's is the arithmetic:
 * it computes `(10 + bonus / 10).toFixed(1)` in floating point and prints "11.0".
 *
 * THE FIGURE COMES OFF THE WIRE WHEN THE DRAFT IS CLEAN, AND IS WITHHELD WHEN IT
 * IS NOT, which is the one thing here that differs from the merchant's screen.
 * `preview` is the SERVER's `previewLadder(config.tiers)`, priced by the same
 * `percentOf` that prices a real top-up in `services/topup.ts`. While the admin
 * is mid-edit it describes the PUBLISHED ladder, not the one on screen — so
 * rendering it beside a changed stepper would put a stale money figure under a
 * new bonus. Recomputing it locally instead would put the rounding rule in a
 * second place, which is what the server's preview exists to avoid.
 *
 * So the example is shown for the rung the admin has not touched, and disappears
 * for one she has. A sentence that is only ever true is better than a sentence
 * that is usually true.
 */
function LadderExample({ tiers, preview }: { tiers: Tier[]; preview: TierPreview[] | null }) {
  const example = tiers.find((t) => t.bonusPercent > 0) ?? tiers[1];
  if (!example || !preview) return null;

  const served = preview.find((p) => p.name === example.name);
  if (
    !served ||
    served.bonusPercent !== example.bonusPercent ||
    served.minVisits !== example.minVisits
  ) {
    return null;
  }

  return (
    <p className="saloned__example">
      Example — a {TIER_LABEL[example.name as LadderTierName]} member topping up{' '}
      {formatFils(fils(served.topUpFils))} KD gets {formatFils(fils(served.creditFils))} KD (+
      {served.bonusPercent}%).
    </p>
  );
}

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
    /*
     * NO `data-bad` ON THE ROW. `SalonEditor` set one here and no CSS rule has
     * ever read it — an attribute hook with nothing behind it, which is the same
     * dead machinery this slice removed from the merchant screen, one element
     * down. The design's console prototype clamps every stepper and validates
     * nothing, so it draws no invalid row to copy. The rung is marked by the
     * sentence under its bonus stepper, which is the carrier either way: colour
     * is never allowed to be the only one.
     */
    <tr>
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
         * Rendered as words rather than as disabled steppers — the ruling the
         * merchant's screen made for the same rung: "a disabled input invites a
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
  reward,
  busy,
  onChange,
}: {
  target: number;
  reward: string | null;
  busy: boolean;
  onChange: (next: number) => void;
}) {
  /*
   * THE DESIGN CLAMPS 4–12 AND THE SERVER ACCEPTS 1–50, so a stored target can sit
   * outside the drawn control's range. The bounds WIDEN to include whatever is
   * stored rather than clamping it: a stepper rendered with `value` below its `min`
   * would pull the number into range on the first press and publish a change the
   * admin did not ask for — a silent edit, which is worse than a control that
   * stretches.
   */
  const min = Math.min(STAMPS_MIN, target);
  const max = Math.max(STAMPS_MAX, target);

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
        because it is showing a specimen customer; this is a salon-wide setting and
        there is no member in view. Three filled dots here would be a stamp count
        belonging to nobody.
      */}
      <ul className="saloned__dots" aria-hidden="true">
        {Array.from({ length: target }, (_, i) => (
          <li key={i} className="saloned__dot" />
        ))}
      </ul>
      <p className="saloned__example saloned__example--stamps">
        {/*
          THE REWARD IS READ-ONLY AND IS SHOWN ANYWAY. `stampReward` and its Arabic
          twin are in `PLATFORM_ONLY_EDITABLE`, so the console MAY write them — but
          the design draws no field for the reward text on either surface, and
          inventing one is adding a feature. What is not optional is naming it: a
          stamp card whose target is tunable while its reward is invisible is a
          control over half a promise.
        */}
        {reward === null
          ? 'One stamp per visit or shop purchase · no top-up bonus in stamps mode.'
          : `Collect ${target} → ${reward.toLowerCase()} · one stamp per visit or shop purchase · no top-up bonus in stamps mode.`}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- loading */

/**
 * interaction-spec.md §4: the skeleton matches the loaded layout's shape.
 *
 * FOUR ROWS is a guess about a salon whose mechanic is not known yet, and a
 * skeleton is the one place a guess about shape is correct. Nothing numeric is
 * painted — a stepper showing "0" before the read lands is a threshold somebody
 * could read as this salon's.
 */
function LoyaltySkeleton() {
  return (
    <>
      <div className="saloned__loyaltymode">
        <Skeleton width={188} height={34} radius={11} />
      </div>
      {TIER_LADDER.map((name) => (
        <div className="saloned__tierskel" key={name}>
          <Skeleton width={90} height={15} />
          <Skeleton width={110} height={30} />
          <Skeleton width={110} height={30} />
        </div>
      ))}
    </>
  );
}
