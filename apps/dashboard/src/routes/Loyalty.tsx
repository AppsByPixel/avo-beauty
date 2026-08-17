import { useEffect, useMemo, useState } from 'react';
import { fils, formatFils, percentOf, type Tier } from '@avo/types';
import { Button, Card, Segmented, Skeleton } from '@avo/ui';
import {
  TIER_LABEL,
  TIER_LADDER,
  useLoyalty,
  usePublishLoyalty,
  type LadderTierName,
} from '../api/loyalty.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Loyalty. `GET`/`PUT /salons/{id}/loyalty`, `perms.loyalty`.
 *
 * WHAT "THE OLD LADDER STAYS VISIBLE" MEANS IN PRACTICE
 *
 * A publish is atomic on the server — one jsonb column, one UPDATE, one
 * transaction carrying its own audit row — so there is no such thing as half a
 * ladder in the database. The client's half of that promise is to never paint a
 * ladder the server has not accepted. So:
 *
 *   - the draft lives in component state and is never written to the cache;
 *   - the cache is written only from the PUT response;
 *   - a failed publish keeps the merchant's typing in the inputs (losing it
 *     would be its own bug) but the status line and the failure banner both say,
 *     in words, that customers are still on the old rules.
 *
 * The one thing that must never happen is a screen that reads as published when
 * it is not, because the merchant then tells a customer about a bonus the API
 * will not pay.
 */

/** The design's per-tier caption. Not on the entity; it is fixed product copy. */
const TIER_PERK: Record<LadderTierName, string> = {
  bronze: 'Starting tier',
  silver: 'Top-up bonus',
  gold: 'Top-up bonus',
  black: '+ Priority booking',
};

interface DraftTier {
  name: LadderTierName;
  /** Held as typed. The API accepts numeric strings from these inputs. */
  visits: string;
  bonusPercent: string;
}

function toDraft(tiers: Tier[] | null): DraftTier[] {
  return TIER_LADDER.map((name) => {
    const found = tiers?.find((t) => t.name === name);
    return {
      name,
      visits: String(found?.minVisits ?? 0),
      bonusPercent: String(found?.bonusPercent ?? 0),
    };
  });
}

const isWholeNumber = (value: string) => /^\d+$/.test(value.trim());

/** The rung's problem, in the design's own words, or null. */
function problemWith(draft: DraftTier[], index: number): string | null {
  const rung = draft[index];
  if (!rung) return null;
  if (!isWholeNumber(rung.visits)) return 'Visits must be a whole number';
  if (!isWholeNumber(rung.bonusPercent)) return 'Bonus must be a whole number';
  if (Number(rung.bonusPercent) > 100) return 'Bonus cannot exceed 100%';
  if (index === 0) return null;
  const below = draft[index - 1];
  if (below && isWholeNumber(below.visits) && Number(rung.visits) <= Number(below.visits)) {
    return `Must be more visits than ${TIER_LABEL[below.name]}`;
  }
  return null;
}

export function Loyalty() {
  const loyalty = useLoyalty();
  const publish = usePublishLoyalty();

  const live = loyalty.data;
  const [mode, setMode] = useState<'tiers' | 'stamps'>('tiers');
  const [draft, setDraft] = useState<DraftTier[]>(() => toDraft(null));
  const [published, setPublished] = useState<string | null>(null);

  /*
   * Seeded from the server once it arrives, and re-seeded after a successful
   * publish — `live.tiers` is then the ladder that is actually live, so the two
   * agree and the screen reads as clean. Not a dependency on `loyalty.data`
   * wholesale: a background refetch that returns identical JSON must not wipe a
   * draft the merchant is halfway through typing.
   */
  const liveKey = JSON.stringify(live?.tiers ?? null);
  useEffect(() => {
    if (!live) return;
    setDraft(toDraft(live.tiers));
    setMode(live.loyaltyMode);
  }, [liveKey, live?.loyaltyMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo(
    () => draft.map((_, i) => problemWith(draft, i)),
    [draft],
  );
  const invalid = problems.some((p) => p !== null);

  const dirty =
    live !== undefined &&
    (mode !== live.loyaltyMode ||
      JSON.stringify(draft) !== JSON.stringify(toDraft(live.tiers)));

  if (loyalty.isError) {
    return (
      <SectionError
        error={loyalty.error}
        forbiddenTitle="You don't have access to loyalty"
        failedTitle="Couldn't load the loyalty rules"
        onRetry={() => void loyalty.refetch()}
        retrying={loyalty.isFetching}
      />
    );
  }

  function onPublish() {
    setPublished(null);
    publish.mutate(
      mode === 'tiers'
        ? {
            mode: 'tiers',
            tiers: draft.map((t) => ({
              name: t.name,
              minVisits: Number(t.visits),
              bonusPercent: Number(t.bonusPercent),
            })),
          }
        : { mode: 'stamps' },
      // The toast copy is the server's, not ours: one place decides what the
      // product says happened.
      { onSuccess: (result) => setPublished(result.message) },
    );
  }

  const status = invalid
    ? 'Fix the highlighted tier before saving.'
    : dirty
      ? 'Unsaved changes — customers see the old rules until you publish.'
      : 'Live for all customers. Existing balances are never affected.';

  return (
    <>
      <div className="loyalty__head">
        <Segmented
          label="Loyalty mechanic"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'tiers', label: 'Tiers' },
            { value: 'stamps', label: 'Stamps' },
          ]}
        />
        <span className="loyalty__hint">
          One mechanic per salon · shop purchases count the same as visits.
        </span>
      </div>

      {loyalty.isPending ? (
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
      ) : mode === 'stamps' ? (
        <StampsPanel
          target={live?.stampTarget ?? null}
          reward={live?.stampReward ?? null}
          switching={dirty}
        />
      ) : (
        <>
          <div className="loyalty__status-row">
            <span className="loyalty__status" data-dirty={dirty || invalid ? '' : undefined}>
              {status}
            </span>
            <Button onClick={onPublish} disabled={publish.isPending || invalid || !dirty}>
              {publish.isPending ? 'Publishing…' : 'Publish changes'}
            </Button>
          </div>

          <div className="loyalty__grid">
            {draft.map((tier, index) => (
              <TierCard
                key={tier.name}
                tier={tier}
                index={index}
                problem={problems[index] ?? null}
                onVisits={(value) =>
                  setDraft((d) => d.map((t, i) => (i === index ? { ...t, visits: value } : t)))
                }
                onBonus={(value) =>
                  setDraft((d) =>
                    d.map((t, i) => (i === index ? { ...t, bonusPercent: value } : t)),
                  )
                }
              />
            ))}
          </div>

          <p className="loyalty__footnote">
            Bonus credit is funded by you, not AVO — the customer app states this. Changing a
            threshold re-evaluates tiers on each customer&rsquo;s next visit.
          </p>
        </>
      )}

      {publish.isError ? (
        <WriteError
          error={publish.error}
          reassurance="Nothing was published — customers are still on the old rules."
        />
      ) : null}

      {published ? (
        <div className="loyalty__toast" role="status">
          <span className="loyalty__toast-dot" aria-hidden="true" />
          {published}
        </div>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- tier card */

interface TierCardProps {
  tier: DraftTier;
  index: number;
  problem: string | null;
  onVisits: (value: string) => void;
  onBonus: (value: string) => void;
}

function TierCard({ tier, index, problem, onVisits, onBonus }: TierCardProps) {
  const locked = index === 0;

  /*
   * The live "10 → 11 KD" line.
   *
   * `percentOf` from @avo/types — the SAME function the API's `previewLadder`
   * calls, which is the same one `services/topup.ts` uses to price a real
   * top-up. The design computes this as `10 + 10 * pct / 100` in floating point;
   * doing that here would put a rounding rule in a second place, and a rounding
   * rule in two places has already disagreed. Integer fils throughout
   * (non-negotiable #1), formatted only at the boundary below.
   *
   * The server also sends its own `preview` for the PUBLISHED ladder. It is not
   * used for this line, because this line has to track what the merchant is
   * typing — and the two agree exactly whenever the draft is clean, which is
   * what makes the preview a promise rather than a coincidence.
   */
  const percent = isWholeNumber(tier.bonusPercent) ? Number(tier.bonusPercent) : 0;
  const topUp = fils(10_000);
  const credit = topUp + percentOf(topUp, Math.min(percent, 100));

  const rule = locked
    ? 'Everyone starts here'
    : `${isWholeNumber(tier.visits) ? tier.visits : '—'}+ visits · +${percent}% on every top-up`;

  return (
    <Card className="tier-card" data-bad={problem ? '' : undefined}>
      <div className="tier-card__name avo-display">{TIER_LABEL[tier.name]}</div>
      <div className="tier-card__rule">{rule}</div>

      {locked ? (
        /*
         * Bronze is the floor: 0 visits, 0 bonus, and the API refuses anything
         * else with `bronze_is_locked`. Rendered as text rather than as disabled
         * inputs — a disabled input invites a merchant to wonder what unlocks it.
         */
        <div className="tier-card__locked">No bonus · not editable</div>
      ) : (
        <div className="tier-card__fields">
          <label className="tier-card__field">
            <span className="avo-label">Visits</span>
            <input
              className="avo-input tier-card__input"
              inputMode="numeric"
              value={tier.visits}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => onVisits(e.target.value)}
            />
          </label>
          <label className="tier-card__field">
            <span className="avo-label">Bonus %</span>
            <input
              className="avo-input tier-card__input"
              inputMode="numeric"
              value={tier.bonusPercent}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => onBonus(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className="tier-card__foot">
        <div className="tier-card__example">
          {/*
            Both amounts through `formatFils`, so "10.000 → 11.000 KD" carries
            three decimals and Western digits in both languages. The design's
            "10 → 11 KD" drops the decimals; money in this product does not.
          */}
          {formatFils(topUp)} &rarr; {formatFils(fils(credit))} KD
        </div>
        <div className="tier-card__perk">{TIER_PERK[tier.name]}</div>
        {problem ? <div className="tier-card__warn">{problem}</div> : null}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ stamps */

function StampsPanel({
  target,
  reward,
  switching,
}: {
  target: number | null;
  reward: string | null;
  switching: boolean;
}) {
  /*
   * The stamp card as the design draws it. The salon's own target and reward
   * come from the API; nothing here is editable, because the design's stamps
   * panel is a display and `PUT` only needs the mode to switch mechanic.
   *
   * A salon on tiers has never had a stamp target set, so both can be null. That
   * is the case the API refuses to publish — `salon_loyalty_config_complete`
   * requires the configuration for whichever mode is active — and it is said
   * here rather than discovered at the Publish button.
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
            This salon runs tiers. A stamp card needs a target and a reward before it can be
            published — those are set by AVO during onboarding.
          </div>
        </>
      )}
      {switching ? (
        <p className="stamps__switching">
          Switching mechanic replaces the tier ladder for every customer. Tier balances are not
          deleted, but no top-up bonus is paid while stamps are live.
        </p>
      ) : null}
    </Card>
  );
}
