import { useMemo } from 'react';
import { Button, Card, EmptyState, InfoBanner, Skeleton } from '@avo/ui';
import { usePlatformActivity } from '../../api/platformActivity.js';
import type { ActivityItem } from '../../api/salon.js';
import { useAllPlatformSalons } from '../../api/platformSalons.js';
import { whenLabel } from '../AuditLog.js';
import { SectionError } from '../sectionState.js';

/**
 * Console → Activity. `GET /v1/platform/activity`, section `activity`.
 *
 * `AVO Owner Console.dc.html:137` § ACTIVITY — a banner and one card of rows,
 * each row a dot, a bolded actor, a phrase, a timestamp under it and a salon pill
 * on the right. No search box, no filter chips, no tabs. That is the whole
 * section as drawn, and it is built as drawn.
 *
 * =========================================================================
 * WHAT THIS FEED IS, WHICH TOOK THE API THREE STREAMS TO ANSWER
 * =========================================================================
 * It is not the merchant's Overview panel with the salon predicate removed, and
 * it is not the audit log renamed. It is BOTH, merged — and the design settles
 * it, because the eight rows it draws come from three different sources:
 *
 *     Latifa A.  topped up 25.000 via KNET        transaction   kind=topup
 *     Maya S.    paid 18.000 · Balayage           transaction   kind=charge
 *     Owner      adjusted Silver tier bonus …     audit_log     kind=rules
 *     Owner      reset password for Sara H.       audit_log     kind=access
 *     Reem S.    reached Gold tier                loyalty_event
 *
 * `routes/activity.ts` reads two of those three, so dropping its salon predicate
 * could never produce a permission change or a rule change; `GET
 * /v1/platform/audit` reads only `audit_log`, so it could never produce a tier
 * climb (nothing writes an audit row for one).
 *
 * TWO OF THE DESIGN'S EIGHT ROWS HAVE NO SOURCE AT ALL, and they are absent
 * rather than faked. "Huda M. upgraded to the Pro plan" and "System suspended
 * Glow Bar · billing hold" are both BILLING: `plan` prices the account and no
 * salon-suspension endpoint exists, so nothing in the product can produce either
 * line. Billing is blocked as `DECISIONS.md` #15. Drawing them would mean putting
 * two fabricated rows in the platform's own event feed.
 *
 * =========================================================================
 * THE SALON PILL RESOLVES AN ID TO A NAME, AND FALLS BACK TO THE ID
 * =========================================================================
 * The design writes a salon NAME on every row; the wire carries `salonId`. The
 * map comes from `GET /v1/platform/salons` — `Audit.tsx`'s pattern, and its
 * caveat holds identically here: that list is gated `salons` and this screen is
 * gated `activity`, so an admin can hold one without the other. A failed name
 * lookup must NOT reach `SectionError` — a feed taken to an error state because a
 * decoration could not be populated would hide the record over a convenience.
 * The id is the fallback, because `SAL-AMARA` is greppable and stable where a
 * blank is neither.
 *
 * `salonId: null` IS A PLATFORM ACTION, and it is a real and common row rather
 * than a defect — the console's own sign-in writes one, as does every controls
 * change and every edit to an admin's sections. The design draws no such row (all
 * eight of its examples belong to a salon) so it supplies no copy for the pill.
 * "AVO" is used, which is this client's existing word for exactly this set:
 * `Audit.tsx` already labels the same rows "AVO actions only" and "AVO platform
 * actions". Reported as the one piece of copy on this screen the design did not
 * write.
 *
 * =========================================================================
 * THE DOT
 * =========================================================================
 * The design assigns dot colours per row by hand and is not systematic about it —
 * two `rules` rows get two different colours (`#5A6B58` and `#6E7F6C`). So the
 * colour is derived here from the stream and kind instead, reusing the client's
 * existing answer rather than transcribing an inconsistent mock: money and
 * loyalty are brand, and an audit row takes the tone `Audit.tsx` already gives
 * its kind. One client answer to "what colour is an access row", on both screens.
 *
 * It is DECORATION. Every row's meaning is carried by its sentence, which is
 * composed server-side; nothing here is legible only by colour.
 *
 * =========================================================================
 * PAGING, AND WHY THIS SCREEN HAS IT WHERE THE OVERVIEW DOES NOT
 * =========================================================================
 * The design draws eight rows and no "load more", the same as the merchant's
 * five. But `routes/activity.ts` deliberately has NO cursor and this endpoint
 * deliberately pays for a composite one, and the API says why: the Overview is a
 * glance and "this screen is the other case — a whole section whose job is
 * looking backwards". A section that could only ever show its first page would
 * make the cursor unreachable. `Audit.tsx` renders the same "Show older" control,
 * so the two console log screens page the same way.
 *
 * The button does not promise a count. `GET /v1/platform/audit` serves `total`
 * and its button says "Show older (N more)"; this endpoint deliberately serves
 * none — the sum of three streams' counts is not the count of the merged list —
 * so this one says "Show older" and claims nothing it cannot count.
 */
export function Activity() {
  const feed = usePlatformActivity();

  /*
   * The id→name map for the pill. Deliberately NOT folded into the error branch
   * below — see the header. `isError` here means "ids instead of names", never
   * "no feed".
   */
  const salonList = useAllPlatformSalons();
  const salonName = useMemo(
    () => new Map(salonList.salons.map((s) => [s.id, s.name])),
    [salonList.salons],
  );

  if (feed.isError) {
    return (
      <SectionError
        error={feed.error}
        forbiddenTitle="You don't have access to activity"
        failedTitle="Couldn't load activity"
        onRetry={() => void feed.refetch()}
        retrying={feed.isFetching}
      />
    );
  }

  const rows = (feed.data?.pages ?? []).flatMap((p) => p.items);

  return (
    <div className="activity">
      {/* The design's banner sentence, verbatim (`AVO Owner Console.dc.html:142`). */}
      <InfoBanner icon={<PulseGlyph />}>
        Live events across every salon — top-ups, charges, deposits, tier changes and account
        actions. The full audit trail for the platform.
      </InfoBanner>

      <Card className="activity__card" flush>
        {feed.isPending ? (
          <ul className="activity__feed">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
              <li key={row} className="activity__row">
                <span className="activity__dot" data-tone="quiet" aria-hidden="true" />
                <span className="activity__body">
                  <Skeleton width={`${74 - row * 5}%`} height={13} />
                  <Skeleton width={72} height={11} />
                </span>
                <Skeleton width={62} height={20} />
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          /*
           * EMPTY — BUILT, CORRECT, AND EFFECTIVELY UNREACHABLE. Said here rather
           * than discovered later.
           *
           * This screen has no filter, so the only empty answer is "the platform
           * has never done anything". But reaching this screen requires a console
           * sign-in, and `POST /auth/platform/session` writes an `audit_log` row
           * with `kind: 'access'` and `salon_id: null` (`routes/auth.ts:626`) —
           * which is precisely a kind and a scope this feed reads, unfiltered.
           * The reader's own arrival therefore guarantees a row, and the log is
           * append-only with a seven-year retention, so it does not age out of
           * the first page either.
           *
           * It is built anyway and NOT deleted: an unreachable state is not an
           * absent one, and the alternative is a screen that renders a bare card
           * if the assumption above ever stops holding. It is reported as
           * unreachable rather than claimed as driven — the same distinction the
           * Overview's feed had to make when its empty state turned out to be
           * hidden behind a refusal.
           *
           * NO ACTION IS OFFERED, and §4 asks for "the one action that fills it".
           * There isn't one: nothing a platform admin can do from this console
           * starts a customer's line, and the honest sentence names what fills it
           * instead of pointing at a button that would not.
           */
          <div className="activity__state">
            <EmptyState
              title="Nothing has happened yet"
              body="Top-ups, charges, deposit returns, tier changes and account actions across every salon land here as they happen."
            />
          </div>
        ) : (
          <ul className="activity__feed">
            {rows.map((item) => (
              <FeedRow key={item.id} item={item} salonName={salonName} />
            ))}
          </ul>
        )}
      </Card>

      {feed.hasNextPage ? (
        <div className="activity__more">
          <Button
            variant="secondary"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line. `<b>{who}</b> {what}`, which is the design's own row — and `what`
 * arrives already phrased.
 *
 * THE AMOUNT IS INSIDE `what` AND IS NEVER RENDERED FROM `amountFils`. The
 * sentence is composed server-side and `api/src/services/activityFeed.ts`
 * explains why in terms of a defect it already fixed once: a top-up's
 * `amount_fils` is what LANDED, bonus included, so printing that column beside
 * "topped up" reads five dinars higher than the customer actually paid. The item
 * carries `amountFils` for a caller that needs to total or colour by it; this row
 * is prose and prints the prose.
 */
function FeedRow({
  item,
  salonName,
}: {
  item: ActivityItem;
  salonName: Map<string, string>;
}) {
  return (
    <li className="activity__row">
      <span className="activity__dot" data-tone={dotTone(item)} aria-hidden="true" />
      <span className="activity__body">
        <span className="activity__text">
          <b>{item.who}</b> {item.what}
        </span>
        <time className="activity__when" dateTime={item.at} title={new Date(item.at).toISOString()}>
          {whenLabel(item.at)}
        </time>
      </span>
      <span className="activity__salon" data-platform={item.salonId === null ? '' : undefined}>
        {item.salonId === null ? 'AVO' : (salonName.get(item.salonId) ?? item.salonId)}
      </span>
    </li>
  );
}

/**
 * Stream and kind → the dot's tone. See the header for why this is derived rather
 * than transcribed from the design's per-row colours.
 *
 * The audit tones are `Audit.tsx`'s `KIND_TONE` by value rather than by import:
 * that map is typed `Record<AuditKind, PillTone>` and this feed's `kind` is one
 * FIELD carrying three different vocabularies (a transaction kind, a loyalty
 * kind, or an audit kind), so indexing it would need a cast that could not fail
 * on a transaction kind that happened to collide. The `stream` discriminator is
 * checked first instead, which is what it is for.
 */
function dotTone(item: ActivityItem): string {
  if (item.stream === 'audit') {
    // `money` is excluded server-side as a duplicate, so only these three arrive.
    if (item.kind === 'risk') return 'danger';
    if (item.kind === 'access') return 'warn';
    return 'neutral';
  }
  return 'brand';
}

/** The design's own banner glyph (`AVO Owner Console.dc.html:141`). */
function PulseGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2.5 10h4l2-5 3 10 2-5h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
