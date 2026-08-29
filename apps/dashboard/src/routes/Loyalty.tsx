import { fils, formatFils } from '@avo/types';
import { Card, EmptyState, InfoBanner, Pill, Skeleton } from '@avo/ui';
import {
  TIER_LABEL,
  TIER_LADDER,
  useLoyalty,
  type LadderTierName,
  type TierPreview,
} from '../api/loyalty.js';
import { SectionError } from './sectionState.js';

/**
 * Merchant → Loyalty. `GET /salons/{id}/loyalty`, `perms.loyalty`. READ ONLY.
 *
 * ==========================================================================
 * THE EDITOR WAS WITHDRAWN. IT WAS NOT BROKEN, AND THIS IS NOT A GAP.
 * ==========================================================================
 * Aftab, verbatim: *"Owner console will control the loyalty part not the
 * merchant (it will be read only for merchant)."* That reverses a decision
 * `design/README.md:136` records as finished — "per-tier **Visits** and
 * **Bonus %** inputs … and a **Publish changes** button … (This closes the
 * phase-2 open item — merchants now edit their own tier rules.)" — and line 283
 * lists "merchant-editable tier rules" among the items CLOSED in an earlier
 * revision. So the design still draws an editor here, deliberately, and this
 * screen deliberately no longer is one. `api/src/routes/loyalty.ts` carries the
 * full argument.
 *
 * WHAT LEFT THIS FILE, AND WHY IT LEFT RATHER THAN BEING DISABLED
 * --------------------------------------------------------------
 * The draft/publish machinery: `DraftTier`, `toDraft`, `problemWith`, the
 * `isWholeNumber` guard, the seeding effect, `dirty`, `invalid`, the three-way
 * status line, the mechanic `Segmented`, the per-rung inputs, `usePublishLoyalty`,
 * the `WriteError` banner and the publish toast. About two thirds of the file.
 *
 * All of it still compiled and none of it could reach the server. Dead machinery
 * that looks live is the defect this build has recorded most often, and the
 * version of it that hides best is exactly this one — a disabled Publish button
 * next to inputs that still accept typing reads as "you lack a permission", which
 * is false, and invites the merchant to go and get it, which cannot work. The
 * screen has no button because there is nothing behind it, anywhere, for her.
 *
 * WHAT THE MERCHANT KEEPS is the ladder itself, unchanged in shape. Read-only is
 * the point rather than a consolation: the ladder was never secret — it is
 * already public to every customer of the salon through `GET /salons/{id}` — and
 * she still has to be able to answer "what do I get at Gold?" at the front desk.
 *
 * THE ONE THING THIS SCREEN MUST DO THAT IT DID NOT HAVE TO BEFORE is say WHY.
 * See § THE SENTENCE below.
 *
 * NO COURTESY PERMISSION GATE, and the reason changed shape without changing
 * answer. It used to be "read and write are the same permission, so the refusal
 * arrives on the read". There is now no write at all, and the read is still
 * `requireDashboardPerm(req, 'loyalty')`, so the refusal still arrives on its own
 * and `SectionError` explains it. Ledger in sectionState.tsx.
 */

/** The design's per-tier caption. Not on the entity; it is fixed product copy. */
const TIER_PERK: Record<LadderTierName, string> = {
  bronze: 'Starting tier',
  silver: 'Top-up bonus',
  gold: 'Top-up bonus',
  black: '+ Priority booking',
};

/**
 * =========================== THE SENTENCE ===============================
 * VERBATIM FROM `api/src/http/errors.ts § loyaltyReadOnly`, which is the 403 body
 * a merchant would receive if she reached the endpoint any other way.
 *
 *     403 loyalty_read_only
 *     "Loyalty rules are set by AVO and cannot be changed here. Contact AVO to
 *      request a change."
 *
 * COPIED RATHER THAN RENDERED FROM A RESPONSE, and that is a deliberate second
 * best. Nothing on this screen requests anything that can be refused any more, so
 * there is no response to read the copy out of — the usual rule ("one place
 * decides what the product says happened") has no mechanism here. Matching the
 * server's sentence word for word is the strongest remaining version of it: a
 * merchant who meets this from any direction reads the same words.
 *
 * WHAT IT MUST NOT SAY, AND THIS IS WHY THE ERROR CODE IS ITS OWN. The generic
 * refusal on this endpoint carried `PERMISSION_COPY.loyalty` — "You don't have
 * permission to change loyalty settings. A manager can grant it." Lane A rejected
 * it for this screen because it is not merely wrong, it is FALSELY ACTIONABLE: no
 * manager can grant it, nobody at the salon can, and the sentence sends her to
 * the one person guaranteed unable to help. The distinct `loyalty_read_only` code
 * exists so a client can tell a withdrawn capability from a missing permission.
 * Do not reintroduce the permission wording on this screen.
 *
 * THE SECOND SENTENCE IS THE ONE THAT ANSWERS THE REAL QUESTION. A merchant who
 * edited this yesterday does not primarily want the button back; she wants to
 * know what happened when Gold moves and she did not move it. `routes/audit.ts`
 * already promises her exactly that — "AVO platform staff actions on your salon
 * appear here too, marked **Owner console**" — and `PUT /salons/{id}/loyalty`
 * writes its audit row against the TARGET salon with `source: 'owner_console'`
 * precisely so the row lands in her log rather than only in AVO's. Pointing at it
 * turns a dead end into a place to look.
 */
const READ_ONLY_BODY =
  'Loyalty rules are set by AVO and cannot be changed here. Contact AVO to request a change.';
const READ_ONLY_TRAIL =
  'Any change AVO makes appears in your audit log, marked Owner console.';

export function Loyalty() {
  const loyalty = useLoyalty();
  const live = loyalty.data;

  if (loyalty.isError) {
    return (
      <SectionError
        error={loyalty.error}
        /*
         * A 403 HERE IS STILL A PERMISSION, AND STILL SAYS SO. `perms.loyalty`
         * gates the READ, a manager genuinely can grant that, and the server's
         * sentence is rendered verbatim by `SectionError`.
         *
         * The server's sentence is nevertheless now stale, and it is not this
         * lane's to rewrite — see the report. `PERMISSION_COPY.loyalty` still
         * says "permission to change loyalty settings" for a permission that no
         * longer controls changing anything; the accurate half ("A manager can
         * grant it") is the half that survives, because what she is being refused
         * here is the VIEW.
         */
        forbiddenTitle="You don't have access to loyalty"
        failedTitle="Couldn't load the loyalty rules"
        onRetry={() => void loyalty.refetch()}
        retrying={loyalty.isFetching}
      />
    );
  }

  return (
    <>
      <div className="loyalty__head">
        {/*
          THE MECHANIC IS A FACT NOW, NOT A CONTROL. It was a `Segmented` with two
          options; switching mechanic is a publish, and publishing is AVO's. A
          two-option control with neither option selectable is the disabled-button
          failure wearing a different component.
        */}
        {loyalty.isPending ? (
          <Skeleton width={92} height={26} radius={999} />
        ) : (
          <Pill tone="brand" dot>
            {live?.loyaltyMode === 'stamps' ? 'Stamps' : 'Tiers'}
          </Pill>
        )}
        <span className="loyalty__hint">
          One mechanic per salon · shop purchases count the same as visits.
        </span>
      </div>

      <InfoBanner>
        {READ_ONLY_BODY} {READ_ONLY_TRAIL}
      </InfoBanner>

      {loyalty.isPending ? (
        <LadderSkeleton />
      ) : live?.loyaltyMode === 'stamps' ? (
        <StampsPanel target={live.stampTarget} reward={live.stampReward} />
      ) : (
        <TierLadder preview={live?.preview ?? null} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- the ladder -- */

/**
 * The published ladder, drawn from the SERVER'S OWN PREVIEW.
 *
 * This screen used to compute the "10 → 11 KD" line itself with `percentOf`,
 * because the line had to track what the merchant was typing and the server only
 * previews what is stored. With no typing left, the stored ladder IS the ladder,
 * so the figure comes off the wire — `topUpFils` and `creditFils`, both integer
 * fils, both produced by the same `percentOf` that prices a real top-up in
 * `services/topup.ts`. One implementation of the rounding rule instead of two
 * that agree by inspection.
 *
 * `preview` IS THE LADDER, not a parallel array to be zipped against `tiers`.
 * `serialiseLoyalty` builds it as `previewLadder(config.tiers)` — one entry per
 * stored rung, in stored order, carrying `minVisits` and `bonusPercent` as well.
 *
 * AND THAT IS WHY IT DOES NOT MAP `TIER_LADDER`. The old code drew four cards
 * unconditionally, filling any rung the salon did not have with zeros; SAL-LUMIERE
 * runs a real, live, TWO-rung ladder from before the ladder was fixed at four
 * (`jsonb_array_length(tiers) = 2`, confirmed in SQL on this lane's database), and
 * that salon's merchant was being shown two rungs it does not have at "0+ visits ·
 * +0%". Rendering what is stored is both simpler and the only honest option, and
 * the four-rung constant survives for the SKELETON, where a guess about shape is
 * all a skeleton ever is.
 */
function TierLadder({ preview }: { preview: TierPreview[] | null }) {
  if (preview === null || preview.length === 0) {
    /*
     * A tiers salon with nothing stored. Reachable — `salon_loyalty_config_complete`
     * requires the configuration for whichever mode is ACTIVE, and a legacy row can
     * sit in tiers mode with a null ladder. It names the thing (interaction-spec.md
     * §4) and does not offer an action, because there is none on this surface.
     */
    return (
      <EmptyState
        title="No tier ladder yet"
        body="This salon has no tier rules on record. AVO sets them up — contact AVO to have a ladder published."
      />
    );
  }

  return (
    <>
      <div className="loyalty__grid">
        {preview.map((rung) => (
          <TierCard key={rung.name} rung={rung} />
        ))}
      </div>

      <p className="loyalty__footnote">
        Bonus credit is funded by you, not AVO &mdash; the customer app states this. Changing a
        threshold re-evaluates tiers on each customer&rsquo;s next visit.
      </p>
    </>
  );
}

function TierCard({ rung }: { rung: TierPreview }) {
  /*
   * Bronze is the floor: 0 visits, 0 bonus, and the API refuses anything else
   * with `bronze_is_locked`. It is identified by NAME rather than by index —
   * the array is bottom-to-top, but a two-rung legacy ladder makes "index 0" a
   * claim about a specific salon's data rather than about the tier.
   */
  const isFloor = rung.name === 'bronze';

  const rule = isFloor
    ? 'Everyone starts here'
    : `${rung.minVisits}+ visits · +${rung.bonusPercent}% on every top-up`;

  return (
    <Card className="tier-card">
      <div className="tier-card__name avo-display">{TIER_LABEL[rung.name]}</div>
      <div className="tier-card__rule">{rule}</div>

      <div className="tier-card__foot tier-card__foot--flat">
        <div className="tier-card__example">
          {/*
            Both amounts through `formatFils`, so "10.000 → 11.000 KD" carries
            three decimals and Western digits. The design's "10 → 11 KD" drops the
            decimals; money in this product does not.
          */}
          {formatFils(fils(rung.topUpFils))} &rarr; {formatFils(fils(rung.creditFils))} KD
        </div>
        <div className="tier-card__perk">{TIER_PERK[rung.name]}</div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ stamps */

function StampsPanel({ target, reward }: { target: number | null; reward: string | null }) {
  /*
   * The stamp card as the design draws it, and it was already a display rather
   * than an editor — the only thing the merchant could do to it was switch
   * mechanic, which was a publish. So this panel lost exactly one prop: the
   * `switching` warning about replacing the tier ladder, which described a
   * transition she can no longer start.
   *
   * A salon on tiers has never had a stamp target set, so both can be null.
   */
  const configured = target !== null && reward !== null;

  return (
    <Card className="stamps">
      {configured ? (
        <>
          <div className="stamps__title avo-display">
            Collect {target} &rarr; {reward.toLowerCase()}
          </div>
          <div className="stamps__sub">
            One stamp per visit or shop purchase. No top-up bonus in this mode.
          </div>
          <ul className="stamps__dots">
            {Array.from({ length: target }, (_, i) => (
              <li key={i} className="stamps__dot">
                {i + 1}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="stamps__title avo-display">No stamp card set up</div>
          <div className="stamps__sub">
            This salon is on stamps but has no card on record. AVO sets the target and the
            reward &mdash; contact AVO to have one published.
          </div>
        </>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- loading */

/**
 * interaction-spec.md §4: the skeleton matches the loaded layout's shape.
 *
 * FOUR CARDS, which is a guess, and the only place in this file a guess is right:
 * the mechanic and the rung count are both unknown until the read lands, and a
 * skeleton's job is to hold a plausible shape rather than to assert one. Nothing
 * numeric is painted — the fabricated-zero rule matters most on the card whose
 * body is a money figure.
 */
function LadderSkeleton() {
  return (
    <div className="loyalty__grid">
      {TIER_LADDER.map((name) => (
        <Card key={name}>
          <Skeleton width="50%" height={19} />
          <Skeleton width="72%" height={12} />
          <div style={{ marginTop: 18 }}>
            <Skeleton width="100%" height={38} />
          </div>
        </Card>
      ))}
    </div>
  );
}
