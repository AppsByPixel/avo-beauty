import { useState } from 'react';
import { ErrorState, Segmented } from '@avo/ui';
import { usePromotions } from '../api/promotions.js';
import { useSalon } from '../api/salon.js';
import { useSession } from '../auth/AuthProvider.js';
import { Boosts } from './marketing/Boosts.js';
import { Campaigns } from './marketing/Campaigns.js';
import { HappyHours } from './marketing/HappyHours.js';
import { SectionError } from './sectionState.js';

/**
 * Merchant → Marketing. Three tabs, all behind `perms.marketing`.
 *
 * The first one carries non-negotiable #8: a merchant cannot send a customer
 * message. Everything in Campaigns is phrased around SUBMIT, and the word "Send"
 * appears nowhere on a control — see marketing/Campaigns.tsx.
 *
 * Boosts and Happy hours are two views of the SAME object the wallet reads
 * (`GET /v1/salons/{id}/promotions`), which is why they share one query here and
 * pass slices down rather than each fetching their own.
 */

type Tab = 'campaigns' | 'boosts' | 'happy';

/** Verbatim from the design's `mkHints`. */
const HINT: Record<Tab, string> = {
  campaigns:
    'Write once, submit to AVO, and it goes out the moment it is approved. Every step is logged with who pressed it.',
  boosts:
    'Different earning rates per branch — the lever for filling a quiet location. Published straight to wallets and scanners.',
  happy:
    'Recurring time windows that pay more, with an optional push the moment they open. Live status comes from the clock.',
};

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'campaigns', label: 'Campaigns' },
  { value: 'boosts', label: 'Branch boosts' },
  { value: 'happy', label: 'Happy hours' },
];

export function Marketing() {
  const [tab, setTab] = useState<Tab>('campaigns');
  const session = useSession('merchant');
  const salon = useSalon();
  const promotions = usePromotions();

  /*
   * THE COURTESY GATE, AND WHY THIS SECTION NEEDS ONE EXPLICITLY.
   *
   * `GET /v1/salons/{id}/promotions` is readable by ANY authenticated principal
   * of the salon — deliberately, because the wallet and the scanner read the
   * same object. So unlike every other section in this dashboard, Marketing's
   * read does NOT 403 for a staff member without `perms.marketing`, and leaning
   * on the read to discover the refusal lets her fill in a whole campaign, or
   * move three boost steppers, before the write tells her she cannot.
   *
   * Non-negotiable #7 still holds and is unchanged: the server enforces this on
   * `PUT /promotions/boosts`, on the happy-hour writes and on
   * `POST /campaigns`, and it would refuse all four if this check were deleted.
   * This is the courtesy, not the control.
   *
   * The copy is the API's own sentence for `marketing`, so a merchant who hits
   * the server's refusal by another route reads the same words.
   */
  if (!session.perms.marketing) {
    return (
      <ErrorState
        title="You don't have access to marketing"
        body="You don't have permission to submit a campaign. A manager can grant it."
      />
    );
  }

  const failed = promotions.isError ? promotions : salon.isError ? salon : null;
  if (failed) {
    return (
      <SectionError
        error={failed.error}
        forbiddenTitle="You don't have access to marketing"
        failedTitle="Couldn't load Marketing"
        onRetry={() => {
          void promotions.refetch();
          void salon.refetch();
        }}
        retrying={promotions.isFetching || salon.isFetching}
      />
    );
  }

  const loading = promotions.isPending || salon.isPending;
  const branches = salon.data?.branches ?? [];

  return (
    <div className="mk">
      <div className="mk__tabs">
        <Segmented options={TABS} value={tab} onChange={setTab} label="Marketing section" />
      </div>
      <p className="mk__hint">{HINT[tab]}</p>

      {tab === 'campaigns' ? (
        <Campaigns branches={branches} loading={loading} />
      ) : tab === 'boosts' ? (
        <Boosts
          branches={branches}
          promotions={promotions.data}
          loading={loading}
        />
      ) : (
        <HappyHours branches={branches} promotions={promotions.data} loading={loading} />
      )}
    </div>
  );
}
