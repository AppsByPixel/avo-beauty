import { useMemo, useState } from 'react';
import { Button, Card, EmptyState, InfoBanner, Skeleton } from '@avo/ui';
import {
  LOYALTY_LABEL,
  PLAN_LABEL,
  usePlatformSalons,
  type PlatformSalon,
} from '../../api/platformSalons.js';
import { SectionError } from '../sectionState.js';

/**
 * Console → Salons. `GET /v1/platform/salons`, gated `analytics` — see
 * `api/platformSalons.ts` for why that is not a typo and who it locks out.
 *
 * `AVO Owner Console.dc.html:202` § SALONS — the list half.
 *
 * =========================================================================
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DRAW
 * =========================================================================
 * The design's section is "list → per-salon editor", and this is the list only.
 * The editor is NOT built, and the reason is an absence rather than a decision to
 * defer: THERE IS NO ENDPOINT A CONSOLE ADMIN CAN USE TO READ OR WRITE ONE SALON.
 * Driven against the real API on `avo_lane_c` with an owner-console token, which
 * is the only way to tell a refusal from a missing route — three digits do not
 * say which guard answered:
 *
 *   GET   /salons/SAL-AMARA                403  "This endpoint belongs to a
 *                                               salon. Open it from the console’s
 *                                               Salons section."      ← the guard
 *   PATCH /salons/SAL-AMARA                403  "This endpoint is for salon
 *                                               staff."               ← the guard
 *   GET   /v1/platform/salons/SAL-AMARA    404  "No such endpoint."   ← absence
 *
 * The first refusal points at THIS SCREEN for the remedy, and the remedy does not
 * exist yet: `requireSalonScoped` in `api/src/auth/principal.ts` says so in as
 * many words — "A platform admin who needs to read a salon's data reads it
 * through a console route gated on the `salons` section… Those routes are not
 * built yet." Nothing in `api/src/routes` is gated on `salons` at all today.
 *
 * So there is no `Manage` button on a row. A control that opens a screen which
 * can only 403 is worse than a column that is not there: it teaches an admin that
 * the console is broken rather than that the feature is unbuilt. The row action,
 * the Live toggle and the City column are all absent for the same reason — each
 * one would be a claim the product cannot honour. Reported to trunk with the two
 * endpoints that would fix it.
 *
 * NO `+ Onboard a salon` BUTTON EITHER. `POST /v1/platform/salons` does not exist
 * yet (Lane A is building it), and the four-step wizard behind that button is the
 * second half of this slice. The button lands with the endpoint, in one change, so
 * the console never offers a wizard that cannot finish.
 *
 * =========================================================================
 * THE BANNER COPY IS THE DESIGN'S FIRST SENTENCE AND NOT ITS SECOND
 * =========================================================================
 * The design writes: "Every salon on AVO. Open one to edit its modules, deposit
 * and loyalty structure — or flip it off to instantly suspend it. Customers keep
 * their balance."
 *
 * Only the first sentence is true of what ships. The rest describes the editor
 * that has no endpoint and a suspend that has no column, so it is dropped rather
 * than paraphrased into something vaguer — copy is verbatim or absent, never
 * softened. The same trim applies to the search box: the design's placeholder is
 * "Search salon or city" and there is no city.
 *
 * NO COURTESY GATE. The read is `requirePlatform(req, 'analytics')`, so an admin
 * without it gets a 403 on load and `SectionError` renders the server's own
 * sentence. A second check here would duplicate the server and drift from it —
 * non-negotiable #7, the sidebar mark is a courtesy and not a control.
 */
export function Salons() {
  const [search, setSearch] = useState('');
  const list = usePlatformSalons();

  const rows = (list.data?.pages ?? []).flatMap((p) => p.items);
  const query = search.trim().toLowerCase();

  /*
   * FILTERED IN THE BROWSER, AND THE WORD "shown" IS WHY THAT IS HONEST. The
   * endpoint has no `?q=`, so there is no server search to call. The count line
   * is the design's own "{n} shown" — a claim about what is on screen, not about
   * what exists — and the pager below stays visible while pages remain, so a
   * filter never silently stands in for a complete search.
   *
   * `nameAr` is matched but not drawn: the design's list has no Arabic column, and
   * an admin who types أمارا is looking for Amara. Matching a field the row does
   * not display is a search affordance, not a hidden column.
   *
   * ABOVE THE ERROR RETURN, AND THAT ORDERING IS THE FIX FOR A REAL CRASH. This
   * `useMemo` originally sat below `if (list.isError) return <SectionError/>`,
   * which is a hooks-count violation: the happy render runs three hooks and the
   * error render runs two, so the first request to actually FAIL took the whole
   * console to "Rendered fewer hooks than expected" — the error boundary, not the
   * error state. Found by killing the API and reloading rather than by reading the
   * file, which is the argument for driving the failure path instead of trusting
   * that it compiles. Every hook this component owns is now called before any
   * return.
   */
  const filtered = useMemo(
    () =>
      query === ''
        ? rows
        : rows.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              s.id.toLowerCase().includes(query) ||
              (s.nameAr ?? '').toLowerCase().includes(query),
          ),
    [rows, query],
  );

  if (list.isError) {
    return (
      <SectionError
        error={list.error}
        forbiddenTitle="You don't have access to salons"
        failedTitle="Couldn't load the salons"
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  }

  return (
    <div className="salons">
      <InfoBanner icon={<StorefrontGlyph />}>Every salon on AVO.</InfoBanner>

      <div className="salons__controls">
        <input
          className="avo-input salons__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search salon"
          aria-label="Search the salons on AVO"
        />
        {/*
          THE COUNT WITHHOLDS ITSELF WHILE PENDING, and so does the caption below.
          `rows` is `[]` before the first page lands, so an unguarded "{n} shown"
          would announce "0 shown" over a skeleton — the fabricated zero the
          no-`0.000` rule bans on money, arriving on a count instead. The same
          defect was found on both audit screens through the sr-only caption.
        */}
        <span className="salons__count" role="status">
          {list.isPending ? '' : `${filtered.length} shown`}
        </span>
      </div>

      <Card className="salons__card" flush>
        <div className="salons__scroll">
          <table className="salons__table">
            <caption className="avo-sr-only">
              Every salon on AVO, oldest first.
              {list.isPending ? '' : ` ${filtered.length} shown.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Salon</th>
                <th scope="col">Plan</th>
                {/* "City" in the design. There is no city column — see the header. */}
                <th scope="col">Branches</th>
                <th scope="col">Members</th>
                <th scope="col">Loyalty</th>
              </tr>
            </thead>
            <tbody>
              {list.isPending ? (
                [0, 1, 2, 3, 4].map((n) => (
                  <tr key={n}>
                    {[0, 1, 2, 3, 4].map((c) => (
                      <td key={c}>
                        <Skeleton width={`${80 - c * 9}%`} height={13} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="salons__empty">
                    {query !== '' ? (
                      /*
                       * NAMES WHAT IT FILTERED. "No salons" under an invisible
                       * search box reads as "AVO has no salons", which on this
                       * screen is a claim about the whole business.
                       */
                      `No salons match “${search.trim()}”.`
                    ) : (
                      <EmptyState
                        title="No salons yet"
                        body="Every salon AVO onboards appears here, with its plan, branches and loyalty mechanic."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((salon) => <SalonRow key={salon.id} salon={salon} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {list.hasNextPage ? (
        <div className="salons__more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Show more salons'}
          </Button>
        </div>
      ) : null}

      {/*
        NOT IN THE DESIGN, AND IT EARNS ITS PLACE. `memberCount` counts tombstoned
        members on purpose — the handler's reasoning is that excluding erased rows
        would make this list disagree with the ledger by exactly the number of
        erasures. An admin reconciling this column against a salon's own dashboard
        will find a difference; one sentence here is the difference between a
        known rule and a suspected bug.
      */}
      <p className="salons__foot">
        Members counts every wallet on a salon's books, including accounts since erased — the same
        figure its transactions still roll up into.
      </p>
    </div>
  );
}

/**
 * One row. Five columns, and the two the design draws that the wire cannot carry
 * — City and Live — are absent rather than filled in. See the screen header.
 */
function SalonRow({ salon }: { salon: PlatformSalon }) {
  return (
    <tr>
      <td>
        <div className="salons__name">
          <span className="salons__initial" aria-hidden="true">
            {/*
              `Array.from` rather than `name[0]`: an Arabic or emoji first
              character is more than one UTF-16 code unit, and `[0]` renders half
              of it. The design's prototype writes `c.name[0]` because its data is
              ASCII; a real salon list is not.
            */}
            {Array.from(salon.name)[0] ?? ''}
          </span>
          <span>
            <span className="salons__salon">{salon.name}</span>
            <span className="salons__id">{salon.id}</span>
          </span>
        </div>
      </td>
      <td>
        {/*
          The plan badge, on the `--avo-plan-*` tokens that exist for exactly this
          — NOT on `Pill`, whose `warn` tone borrows `plan.pro.bg` and would say a
          Starter salon is a warning. `Pill`'s own docstring makes that objection
          about the audit log; it applies in reverse here.
        */}
        <span className="salons__plan" data-plan={salon.plan}>
          {PLAN_LABEL[salon.plan]}
        </span>
      </td>
      <td className="salons__num">{salon.branchCount}</td>
      <td className="salons__num">{salon.memberCount.toLocaleString('en-US')}</td>
      <td className="salons__loyalty">{LOYALTY_LABEL[salon.loyaltyMode]}</td>
    </tr>
  );
}

/** The design's own storefront mark, from the Salons nav item and banner. */
function StorefrontGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 17V8l7-4 7 4v9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
