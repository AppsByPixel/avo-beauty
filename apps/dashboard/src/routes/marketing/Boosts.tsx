import { useEffect, useState } from 'react';
import type { Branch, PromotionSet } from '@avo/types';
import { Button, Card, InfoBanner, Pill, Skeleton, Stepper } from '@avo/ui';
import {
  BOOST_BOUNDS,
  NEUTRAL_BOOST,
  usePublishBoosts,
  type BoostValues,
} from '../../api/promotions.js';
import { WriteError } from '../sectionState.js';

/**
 * Marketing → Branch boosts.
 *
 * The steppers and the wallet's "2× visits / +10% top-ups" chips are two views of
 * one `boosts` object — api-contract.md § Promotion set. Nothing is duplicated
 * here; the draft below is the merchant's *unpublished edit*, which is a
 * different thing from a second copy of the live value, and the screen says
 * which is which.
 */

export interface BoostsProps {
  branches: Branch[];
  promotions: PromotionSet | undefined;
  loading: boolean;
}

type Draft = Record<string, BoostValues>;

/** Every branch the salon has, defaulted to neutral — see `usePublishBoosts`. */
function draftFrom(branches: Branch[], promotions: PromotionSet | undefined): Draft {
  const live = promotions?.boosts ?? {};
  return Object.fromEntries(
    branches.map((b) => [b.id, { ...NEUTRAL_BOOST, ...(live[b.id] ?? {}) }]),
  );
}

export function Boosts({ branches, promotions, loading }: BoostsProps) {
  const publish = usePublishBoosts();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(branches, promotions));

  /*
   * Re-seed from the server whenever the live set changes — the first load, and
   * again after a successful publish. `publishedAt` is the identity of a
   * published set, so it is the dependency: two publishes with identical values
   * still produce a new one, and re-seeding on it cannot drop an edit made while
   * a publish was in flight without the merchant seeing the result of that
   * publish first.
   */
  useEffect(() => {
    setDraft(draftFrom(branches, promotions));
  }, [branches, promotions?.boostsPublishedAt]);

  const dirty =
    promotions !== undefined &&
    branches.some((b) => {
      const live = { ...NEUTRAL_BOOST, ...(promotions.boosts[b.id] ?? {}) };
      const next = draft[b.id] ?? NEUTRAL_BOOST;
      return live.visit !== next.visit || live.topup !== next.topup || live.stamp !== next.stamp;
    });

  function set(branchId: string, key: keyof BoostValues, value: number) {
    setDraft((prev) => ({
      ...prev,
      [branchId]: { ...(prev[branchId] ?? NEUTRAL_BOOST), [key]: value },
    }));
  }

  return (
    <Card className="mk__boosts">
      <InfoBanner>
        Push a quieter branch by paying more for the same behaviour there. The wallet stays one
        balance — only what a visit <i>earns</i> changes.
      </InfoBanner>

      {loading ? (
        <div className="mk__skeletons">
          {[0, 1].map((n) => (
            <Skeleton key={n} width="100%" height={120} />
          ))}
        </div>
      ) : branches.length === 0 ? (
        <p className="mk__none">This salon has no branches yet, so there is nothing to boost.</p>
      ) : (
        branches.map((branch) => {
          const values = draft[branch.id] ?? NEUTRAL_BOOST;
          const boosted =
            values.visit > 1 || values.topup > 0 || values.stamp > 1;
          return (
            <div key={branch.id} className="mk__boost">
              <div className="mk__boosthead">
                <span className="mk__boostname">{branch.name}</span>
                <span className="mk__boostid">{branch.id}</span>
                <Pill tone={boosted ? 'brand' : 'quiet'}>{boosted ? 'Boosted' : 'Base rate'}</Pill>
              </div>

              <div className="mk__boostgrid">
                <div className="mk__boostcell">
                  <div className="mk__boostlabel">Visit value</div>
                  <Stepper
                    value={values.visit}
                    {...BOOST_BOUNDS.visit}
                    onChange={(v) => set(branch.id, 'visit', v)}
                    format={(v) => `${v}×`}
                    label={`Visit value at ${branch.name}`}
                    valueText={`${values.visit} times`}
                  />
                </div>
                <div className="mk__boostcell">
                  <div className="mk__boostlabel">Top-up bonus</div>
                  <Stepper
                    value={values.topup}
                    {...BOOST_BOUNDS.topup}
                    onChange={(v) => set(branch.id, 'topup', v)}
                    format={(v) => `+${v}%`}
                    label={`Top-up bonus at ${branch.name}`}
                    valueText={`plus ${values.topup} percent`}
                  />
                </div>
                <div className="mk__boostcell">
                  <div className="mk__boostlabel">Stamps per visit</div>
                  <Stepper
                    value={values.stamp}
                    {...BOOST_BOUNDS.stamp}
                    onChange={(v) => set(branch.id, 'stamp', v)}
                    format={(v) => `${v}×`}
                    label={`Stamps per visit at ${branch.name}`}
                    valueText={`${values.stamp} times`}
                  />
                </div>
              </div>

              {/* The plain-language summary the design puts under each branch. */}
              <p className="mk__boostsummary">{summarise(branch.name, values)}</p>
            </div>
          );
        })
      )}

      <div className="mk__boostfoot">
        <span className="mk__boostnote">
          {dirty
            ? 'Higher earning costs you margin on every visit at that branch.'
            : publishedNote(promotions)}
        </span>
        <Button
          onClick={() => publish.mutate(draft)}
          disabled={!dirty || publish.isPending}
          aria-disabled={!dirty || publish.isPending}
        >
          {publish.isPending ? 'Publishing…' : dirty ? 'Publish changes' : 'Published'}
        </Button>
      </div>

      {publish.isError ? (
        <WriteError
          error={publish.error}
          reassurance="Nothing was published — your branches are still earning at the rates above."
        />
      ) : null}
    </Card>
  );
}

/** "A visit at Salmiya is worth 2 visits, tops up 10% richer and earns 2 stamps." */
function summarise(name: string, v: BoostValues): string {
  const parts: string[] = [];
  if (v.visit > 1) parts.push(`counts as ${v.visit} visits`);
  if (v.topup > 0) parts.push(`adds ${v.topup}% to every top-up`);
  if (v.stamp > 1) parts.push(`earns ${v.stamp} stamps`);
  if (parts.length === 0) return `A visit at ${name} earns the salon's base rate.`;
  const last = parts.pop() as string;
  return `A visit at ${name} ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

function publishedNote(promotions: PromotionSet | undefined): string {
  if (!promotions?.boostsPublishedAt) return 'Live for all staff and scanners.';
  const at = new Date(promotions.boostsPublishedAt);
  const by = promotions.boostsPublishedBy;
  return `Live for all staff and scanners — published ${at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })}${by ? ` by ${by}` : ''}.`;
}
