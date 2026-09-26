/**
 * Row 365, dashboard/console half: every screen has its loading, empty, error
 * and offline states built — and stays having them after the people who built
 * them are gone.
 *
 * SOURCE SCANS, for lane B's stated reason (`failureStates.test.ts`): there is
 * no renderer in this workspace, and adding one rewrites the trunk-owned
 * lockfile. And as there, a render test would aim at the wrong risk — none of
 * these guarantees is about a component drawing a value wrongly:
 *
 *   the states rule    a screen that fetches renders `SectionError` (or the
 *                      Overview's ErrorState split) for its error and offline
 *                      answers, and a Skeleton while pending. `SectionError`
 *                      is where offline is told apart from a server failure
 *                      (`ApiError.isConnectivity`) and where a 403 renders the
 *                      SERVER's sentence — so its presence is the whole
 *                      four-state vocabulary, not a fraction of it.
 *   the announced rule a pending screen must not announce a zero it is not
 *                      painting. `total ?? 0` reached a sr-only <caption> as
 *                      "0 entries match the current filter" while the visible
 *                      count line correctly rendered '' — on BOTH audit
 *                      screens, found on one and fixed on its already-merged
 *                      sibling. The premature-zero class arriving through the
 *                      accessibility tree instead of the paint.
 *
 * Truthful-by-accident and announced-not-painted are the classes this build
 * keeps finding; both are invisible to a test that only checks the happy path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../shell/navItems.js';
/*
 * Comments in this codebase discuss the identifiers these scans search for, at a
 * ratio that makes a naive `includes()` wrong in the direction that reads as
 * passing — `ShopOrders.tsx` says the word "truncated" nine times in prose about
 * why it is rendered. See `testing/stripComments.ts` for the argument.
 */
import { stripComments } from '../testing/stripComments.js';

const here = __dirname;
const read = (name: string) => readFileSync(join(here, name), 'utf8');

/**
 * The screens that fetch and therefore own the four states themselves.
 *
 * NOT a glob, deliberately — the exclusions below are excluded for stated
 * reasons, and a list that explains itself is the point.
 */
const SECTION_SCREENS = [
  'Overview.tsx',
  'Appointments.tsx',
  'Team.tsx',
  'Loyalty.tsx',
  'Settings.tsx',
  /**
   * Merchant → Settings → Tills. A PANEL INSIDE A SCREEN, here for
   * `console/SupportPanel.tsx`'s exact reason: it owns its own fetch against a
   * DIFFERENT guard from its host's.
   *
   * `Settings.tsx` reads `GET /salons/{id}`, which is `requirePrincipal` and no
   * permission at all. This reads `GET /salons/{id}/devices`, which is
   * `requirePerm(req, 'either', 'dashboard')`. Two independent guards means two
   * independent failures, so a `SectionError` here is its own answer rather than
   * a drifting copy of its host's — and nothing hands it a pending state,
   * because its host's read landing says nothing about whether its own has.
   *
   * It is also the reason its host stopped early-returning over the whole
   * screen: Settings' courtesy gate is `perms.loyalty` and this panel's is
   * `perms.dashboard`, and one screen-level check for two orthogonal permissions
   * is wrong in both directions at once. `Settings.tsx § THE GATE MOVED FROM THE
   * SCREEN TO THE PANELS` has the argument.
   *
   * The census's own distinction, restated because this entry is the third to
   * turn on it: not "is it routed" but "does it own a read". The router never
   * mounts this, so the routed-component assertion below will not see it.
   */
  'Tills.tsx',
  /**
   * Merchant → Overview → Gross by day. NEW WORK; there is no chart in the
   * design bundle (`routes/salesTrendRules.ts` carries the disclosure).
   *
   * A PANEL INSIDE A SCREEN, in this list for the pair of reasons `Tills.tsx`
   * and `ShopOrders.tsx` are — and it needs both of them, because on its own
   * each entry's argument would exclude it.
   *
   * IT OWNS ITS OWN READS, PLURAL. `Overview.tsx` reads
   * `GET /salons/{id}/metrics` and `GET /salons/{id}/activity`; this reads
   * `GET /salons/{id}` (for the salon's time zone, which decides WHICH DAYS to
   * ask for) and `GET /salons/{id}/reports/sales`. Four endpoints, four
   * independent failures — and the first of those two is the one that makes
   * this entry unavoidable: a salon load that fails leaves this card with no
   * window at all while the tiles above it are perfectly fine, which is a state
   * nothing in `Overview.tsx` can answer for.
   *
   * SAME GATE, WHICH IS NOT THE SAME THING AS ONE READ — `ShopOrders.tsx`'s
   * distinction, and it applies verbatim. `sales` is `requireDashboardPerm(req,
   * 'dashboard')`, the same guard the metrics beside it hold, and a shared
   * permission does not make two endpoints fail together.
   *
   * IT CARRIES TWO THINGS THAT ARE NOT ONE OF THE FOUR, both refusals of a
   * payload rather than merchant situations: a time zone `Intl` does not
   * recognise (no window can be composed), and a window that came back rolling
   * rather than calendar (no days can be named). Each explains and offers no
   * retry, because retrying returns the same answer. See `SalesTrend.tsx`.
   *
   * Not routed — `Overview.tsx` mounts it — so the routed-component assertion
   * below will not see it, exactly as it does not see `Tills.tsx`.
   */
  'SalesTrend.tsx',
  /**
   * Merchant → Appointments → Week. NEW WORK; there is no calendar view in the
   * design bundle (`routes/appointmentsWeekRules.ts` carries the disclosure —
   * every "calendar" in the merchant artboard is Google Calendar as an
   * AVAILABILITY SOURCE, not a view of appointments).
   *
   * A VIEW INSIDE A SCREEN, in this list rather than in a host/subview pair, and
   * it needs both halves of the argument `SalesTrend.tsx` needs.
   *
   * IT OWNS ITS OWN READS, PLURAL, AND ONE OF THEM IS A DIFFERENT QUERY ON THE
   * SAME ENDPOINT. `Appointments.tsx` reads ONE page of
   * `GET /salons/{id}/bookings`; this walks the cursor through it with its own
   * `useInfiniteQuery` under its own key, and reads `GET /salons/{id}` besides,
   * for the time zone that decides which COLUMN a booking is drawn in. Two cache
   * entries on one route still fail independently — a paused page or a mid-walk
   * 503 is this view's answer and not its host's — and nothing hands it a
   * pending state, because the list's read landing says nothing about the walk.
   *
   * SAME GATE, WHICH IS NOT THE SAME THING AS ONE READ — `ShopOrders.tsx`'s
   * distinction, applied to the strongest case for it yet: the two reads share
   * `perms.appointments` AND the same URL, and are still two independent
   * failures.
   *
   * IT CARRIES A FIFTH THING THAT IS NOT ONE OF THE FOUR, and it is the reason
   * the view exists in the shape it does: `GET /salons/{id}/bookings` caps a
   * page at 200 with no date range, so a week grid drawn from one page shows
   * hours nobody checked as free. This view REFUSES TO DRAW a week it cannot
   * prove it has whole — see the capped-list describe at the foot of this file,
   * which pins that refusal the way `ShopOrders`' truncation notice is pinned.
   * It also carries the unusable-time-zone refusal `SalesTrend.tsx` carries, for
   * the same field and the same reason.
   *
   * Not routed — `Appointments.tsx` mounts it behind the List/Week control — so
   * the routed-component assertion below will not see it, exactly as it does not
   * see `Tills.tsx` or `SalesTrend.tsx`.
   */
  'AppointmentsWeek.tsx',
  'Accounts.tsx',
  'AuditLog.tsx',
  'Reports.tsx',
  /**
   * Merchant → Shop. Owns its own read (`GET /salons/{id}/products`, `perms.shop`)
   * and three writes behind the same permission, so it answers for its own four
   * states.
   *
   * IT ALSO CARRIES A FIFTH THING THAT IS NOT ONE OF THE FOUR, and the distinction
   * is the reason this comment exists: `modules.shop` being off is neither an error
   * nor an empty list. `services/moduleAccess.ts` § `assertShopReadable` returns
   * early for a staff principal, so the read answers 200 with the full catalog
   * whether the module is on or off — the module state reaches this screen from
   * `GET /salons/{id}` and renders as a NOTICE over a working editor, never through
   * `SectionError`. A test that folded the two together would be asserting that the
   * screen refuses something the server serves.
   */
  'Shop.tsx',
  /**
   * Merchant → Shop → Orders. The fulfilment board.
   *
   * A TAB INSIDE A SECTION, and it is in THIS list rather than in a host/subview
   * pair for the reason `marketing/Campaigns.tsx` is: it owns its own fetch. The
   * catalogue reads `GET /salons/{id}/products` and this reads
   * `GET /v1/salons/{id}/orders` — two routes, two independent failures, so a
   * `SectionError` here is its own answer and not a drifting copy of its host's.
   * Nothing hands it a pending state either; `Shop.tsx` landing its salon read
   * says nothing about whether this one has.
   *
   * SAME GATE, WHICH IS NOT THE SAME THING AS ONE READ. Both routes are
   * `perms.shop`, so unlike `Tills.tsx` this tab does not have a second guard to
   * point at — and it still owns four states, because a shared permission does
   * not make two endpoints fail together. That distinction is worth writing down
   * because it is the one this entry could be argued out of.
   *
   * IT CARRIES A FIFTH THING, again not one of the four: `truncated`. A cap of
   * 200 reported honestly by the API and rendered rather than hidden — see
   * `ShopOrders.tsx § the truncation`. Not an error and not an empty; the board
   * loaded, it is simply incomplete, and the notice below pins that it is drawn.
   *
   * AND IT HAS THREE EMPTIES, NOT ONE. Nothing ordered with the shop on, nothing
   * ordered with `modules.shop` off, and nothing at the filtered status. The
   * middle one is the reason `shopOn` is a prop: "orders land here as soon as
   * they're placed" is a false promise to a salon where nobody can place one.
   */
  'ShopOrders.tsx',
  /**
   * The console's Accounts list and the platform feed. Both own their own read
   * (`GET /v1/platform/accounts`, `GET /v1/platform/activity`) behind their own
   * section gate, so both answer for their own four states.
   *
   * `console/Accounts.tsx` exports `ConsoleAccounts`, not `Accounts` — the
   * merchant's `Accounts.tsx` above is a different screen on a different endpoint
   * behind a different guard. The router test below matches on the mounted
   * component NAME, so the two are distinguishable there rather than colliding.
   */
  'console/Accounts.tsx',
  /**
   * Console → Accounts → one customer's AVO vouchers.
   *
   * A PANEL INSIDE A SCREEN, in THIS list rather than in a host/subview pair, for
   * `SupportQueue`'s reason exactly: it owns its own fetch. `console/Accounts.tsx`
   * reads `GET /v1/platform/accounts` and this reads `GET /v1/vouchers?memberId=`
   * — two routes that fail independently, so a `SectionError` here is its own
   * answer and not a drifting copy of its host's, and nothing hands it a pending
   * state because its host's read landing says nothing about whether this one has.
   *
   * SAME SECTION GATE, WHICH IS NOT THE SAME THING AS ONE READ — `ShopOrders`'s
   * distinction. Both are `requirePlatform(req, 'accounts')`, so unlike
   * `Tills.tsx` this panel has no second guard to point at, and it still owns four
   * states. The 403 arm is reachable only by a mid-session revocation through
   * `Admins.tsx` (the server re-reads `platform_admin` per request) — built
   * anyway, because non-negotiable #7's claim is that the server refuses whatever
   * the UI did.
   *
   * The router never mounts it, so the routed-component assertion below will not
   * see it. That is the census's standing distinction: not "is it routed" but
   * "does it own a read".
   */
  'console/AccountVouchers.tsx',
  'console/Activity.tsx',
  'console/Admins.tsx',
  'console/Analytics.tsx',
  'console/Audit.tsx',
  'console/Approvals.tsx',
  'console/Controls.tsx',
  'console/Policies.tsx',
  'console/Salons.tsx',
  /**
   * The per-salon editor. Owns its OWN read (`GET /v1/platform/salons/:id`), not a
   * slice of the list's — a different route, a different 404, and a bookmarked URL
   * can land on it with no list ever fetched. So it answers for its own four states
   * rather than borrowing `Salons.tsx`'s, which is the host/subview distinction
   * this census keeps drawing.
   */
  'console/SalonEditor.tsx',
  /**
   * The loyalty publisher, rendered as a card INSIDE `SalonEditor` — and in this
   * list rather than in HOST_SUBVIEWS, for `SupportQueue`'s exact reason.
   *
   * Its host owns `GET /v1/platform/salons/:id`; this owns `GET
   * /salons/{id}/loyalty`, a different route with a different guard resolved from
   * the principal (`sections.salons` for the console, `perms.loyalty` +
   * `requireSameSalon` for a merchant). Two reads fail independently, so a
   * `SectionError` here is its own answer and not a drifting copy of its host's —
   * and nothing hands it a pending state, because its host's read landing says
   * nothing about whether its own has.
   *
   * It is also this build's second write surface on one screen: the host's Save
   * and this card's Publish go to different endpoints and leave different audit
   * rows, so each owns its own `WriteError` too.
   */
  'console/SalonLoyalty.tsx',
  /**
   * IN THIS LIST, NOT THE SUBVIEW ONE, and the census itself made the point: the
   * first run of this file classed Campaigns as a pure subview and FAILED — it
   * owns a second fetch (the submitted-campaigns queue) with its own
   * `SectionError`, deliberately, with the rationale written at the call site
   * ("the one read error in the dashboard not going through SectionError…"). The
   * wrong classification lasted exactly one test run, which is the argument for
   * the census.
   */
  'marketing/Campaigns.tsx',
  /**
   * A PANEL INSIDE A SCREEN, and it belongs here for Campaigns' exact reason.
   *
   * `console/Policies.tsx` renders it, so the router never mounts it and the
   * second test below will not see it — but it owns its own fetch
   * (`useSupportConfig`, on `GET /v1/platform/support`) against a DIFFERENT guard
   * from its host's: `requirePrincipal` with no section, where the policy draft
   * is `policies`-gated. Two independent guards means two independent failures,
   * which is why Policies stopped early-returning over the whole screen and why
   * this panel answers for itself.
   *
   * The distinction the census keeps making: not "is it routed" but "does it own
   * a read". `marketing/Boosts.tsx` is handed its loading state by a host that
   * owns the fetch, and a `SectionError` in it would be a drifting second copy.
   * This one has no such host.
   */
  'console/SupportPanel.tsx',
  /**
   * The queue, and it is a SECOND fetch inside the same panel rather than a
   * subview of it — `SupportPanel` owns `GET /v1/platform/support` and this owns
   * `GET /v1/support/tickets`, on a different guard again (`requireQueueReader`,
   * which resolves to `policies` for a console principal and `perms.dashboard` for
   * a merchant one). Two reads, two failures, two answers.
   *
   * So it is here and not in HOST_SUBVIEWS: nothing hands it a loading state, and
   * a `SectionError` in it is its own and not a drifting copy of its host's.
   */
  'console/SupportQueue.tsx',
] as const;

/**
 * The marketing HOST and its pure subviews.
 *
 * `Marketing.tsx` owns the shared fetch (`usePromotions` + `useSalon`) and the
 * error/offline answer for all three tabs — but NOT the pending paint: it hands
 * `loading` down and the subviews draw their own Skeletons where the cards will
 * be, so the pending layout matches the loaded one. The census's first run
 * asserted a Skeleton on the host, failed, and this is the corrected model
 * rather than a loosened assertion.
 *
 * A `SectionError` inside a PURE subview would be a second, drifting copy of
 * the host's answer — its absence is asserted, not tolerated. (Campaigns is not
 * pure — see SECTION_SCREENS.)
 */
const HOST = 'Marketing.tsx';
const HOST_SUBVIEWS = ['marketing/Boosts.tsx', 'marketing/HappyHours.tsx'] as const;

/**
 * The doors. Lane B's `PinScreen` ruling, ported: a sign-in screen owes the
 * OFFLINE guarantee — "can't reach" and "wrong password" are different next
 * moves — but it must NOT render the sections' error vocabulary, because there
 * is no session to explain and the screen IS the remedy. Each classifies
 * connectivity in its own catch instead.
 */
const DOORS = ['SignIn.tsx', 'ConsoleSignIn.tsx'] as const;

/**
 * Not screens.
 *
 *   NotBuiltYet.tsx     a static explainer with no request — its whole body is
 *                       one EmptyState; there is nothing to load, err or lose.
 *   sectionState.tsx    the shared states VOCABULARY (SectionError, WriteError,
 *                       the courtesy-gate ledger) — the thing under test, not a
 *                       tested thing.
 */
const NON_SCREENS = ['NotBuiltYet.tsx', 'sectionState.tsx'] as const;

/**
 * Every route component in a directory — and NOT the tests beside them.
 *
 * `.test.tsx` IS EXCLUDED, AND IT HAD TO BE. Until Shop there was no render test
 * anywhere in this tree, so every `.tsx` under `routes/` was a screen and the
 * simple extension check was exact. `routes/shopRender.test.tsx` is the first
 * file that is a `.tsx`, is not a screen, and belongs next to its subject rather
 * than in another directory — and without this filter it would have been demanded
 * as a census entry, i.e. a test file required to declare its own four states.
 *
 * The guard does not weaken: `sectionState.tsx` is still a NON_SCREENS entry
 * because it is production source, and anything that is not a test still has to
 * be classified by name. What changes is only that a file whose name says it is a
 * test is not mistaken for a screen.
 */
function tsxOnDisk(dir: string, prefix = ''): string[] {
  return readdirSync(join(here, dir === '.' ? '' : dir), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'),
    )
    .map((entry) => `${prefix}${entry.name}`);
}

describe('the screen census stays honest', () => {
  /**
   * The guard on the lists above. A screen added to any of these directories
   * joins a list or fails here BY NAME — the only moment classification is
   * cheap. This is the assertion that failed on its own author's list the
   * first time lane B ran the pattern, which is the argument for it.
   */
  it('accounts for every route component on disk, in exactly one list', () => {
    const onDisk = [
      ...tsxOnDisk('.'),
      ...tsxOnDisk('console', 'console/'),
      ...tsxOnDisk('marketing', 'marketing/'),
    ].sort();
    const accounted = [...SECTION_SCREENS, HOST, ...HOST_SUBVIEWS, ...DOORS, ...NON_SCREENS].sort();
    expect(onDisk).toEqual(accounted);
  });

  /**
   * The router agrees with the census — every component ANY route in that file
   * mounts is either a screen this file classifies, or one of the two frames.
   *
   * THIS USED TO SCAN THE TWO `SECTIONS` TABLES AND ONLY THOSE, and the narrower
   * version had a hole exactly the shape of the first route that could not live in
   * a table. `/console/salons/$id` is declared beside `CONSOLE_SECTIONS` rather
   * than inside it, because `.map()` over a tuple containing one parameterised path
   * makes `params` required on every route it builds — see router.tsx § the
   * per-salon editor. A table-only scan would have mounted a fetching screen with
   * no four-state classification and reported nothing.
   *
   * So the scan is the whole file now, and the exemptions are NAMED rather than
   * implied by where a route happens to be declared. `NotBuiltYet` is not among
   * them because it is mounted as an inline arrow (`component: () => <NotBuiltYet`)
   * which this pattern does not match, and it is in NON_SCREENS regardless.
   */
  it('every routed component is census-listed, wherever its route is declared', () => {
    const router = readFileSync(join(here, '..', 'router.tsx'), 'utf8');
    const mounted = [...router.matchAll(/component: ([A-Z]\w+)/g)].map((m) => m[1]!);
    // A smoke alarm for a regex that stopped matching: every route in both trees.
    expect(mounted.length).toBeGreaterThanOrEqual(17);

    /** The two shells. Layout routes, not screens — they own no read of their own. */
    const FRAMES = ['MerchantShell', 'ConsoleShell'];
    /*
     * A FILE MAY EXPORT ITS BASENAME, OR — UNDER `console/` — THAT BASENAME
     * PREFIXED `Console`.
     *
     * `console/Accounts.tsx` exports `ConsoleAccounts`, because `Accounts.tsx`
     * beside it is the MERCHANT's team screen and the router imports both. Two
     * screens genuinely named the same thing by the design, on two surfaces,
     * reading two endpoints behind two different guards — so one of them has to
     * carry the surface in its symbol, and the console is the one that does.
     *
     * THIS DOES NOT WIDEN THE GUARD. Both candidates are derived from a censused
     * filename, so a mounted component still has to correspond to a file in a
     * list; what it stops is a naming collision being resolvable only by moving a
     * file out of the directory it belongs in. A component named after nothing on
     * disk still fails, which is the property this assertion is for.
     */
    const censusNames = [...SECTION_SCREENS, HOST, ...DOORS].flatMap((f) => {
      const base = f.replace(/^(console|marketing)\//, '').replace('.tsx', '');
      return f.startsWith('console/') ? [base, `Console${base}`] : [base];
    });
    for (const name of mounted) {
      expect(
        [...censusNames, ...FRAMES],
        `router mounts <${name}> but the census does not class it. Add it to a list ` +
          `in stateCensus.test.ts — a routed screen that owns a read owes four states.`,
      ).toContain(name);
    }
    // The editor is the route the widened scan exists for; pin it by name so a
    // regression to a table-only scan fails here rather than going quiet.
    expect(mounted).toContain('SalonEditor');
  });

  /**
   * A SIDEBAR ITEM THAT SAYS `built: true` HAS SOMEWHERE TO GO.
   *
   * `router.tsx` derives the placeholder routes from `!item.built`, so the two
   * halves are already paired in one direction: a section that is NOT built gets
   * `NotBuiltYet` and cannot dead-end. The other direction is unguarded — flipping
   * `built: true` without adding a `SECTIONS` row leaves the nav item with no route
   * at all, which is a 404 on a link the sidebar renders as live.
   *
   * Shop is the section that made this worth pinning: it is the LAST merchant item
   * to flip, so `placeholderRoutes` is now empty and the fallback that used to
   * catch a mistake here catches nothing. Discovered while flipping it, added with
   * it.
   */
  it('every built merchant nav item has a real route, not a dead sidebar link', () => {
    const router = readFileSync(join(here, '..', 'router.tsx'), 'utf8');
    const routed = new Set(
      [...router.matchAll(/\{ path: '([^']+)', component: \w+ \}/g)].map((m) => m[1]!),
    );
    // A zero result is a claim about the regex, not about the router.
    expect(routed.size).toBeGreaterThanOrEqual(9);

    const built = NAV_ITEMS.filter((item) => item.built);
    expect(built.length).toBeGreaterThan(0);
    for (const item of built) {
      expect(
        routed,
        `the sidebar says ${item.title} is built, but router.tsx mounts nothing at ` +
          `${item.to}. With every merchant item built there is no placeholder route ` +
          `left to catch this — the link 404s.`,
      ).toContain(item.to);
    }
  });
});

describe('every fetching screen owns the four-state vocabulary', () => {
  it.each(SECTION_SCREENS)('%s renders the error/offline vocabulary', (name) => {
    // SectionError carries error AND offline AND the 403 sentence; Overview
    // splits the same vocabulary through ErrorState for its stale-not-blank rule.
    expect(read(name)).toMatch(/SectionError|ErrorState/);
  });

  it.each(SECTION_SCREENS)('%s has a pending state', (name) => {
    expect(read(name)).toContain('Skeleton');
  });
});

describe('the marketing host and its pure subviews split the states as designed', () => {
  it.each(HOST_SUBVIEWS)('%s paints pending and owns write errors, never the fetch error', (name) => {
    const src = read(name);
    expect(src).toContain('Skeleton');
    expect(src).toContain('WriteError');
    expect(src).not.toContain('SectionError');
  });

  it('the host owns the shared fetch and its error/offline answer', () => {
    const src = read(HOST);
    expect(src).toContain('SectionError');
    expect(src).toContain('usePromotions');
    // The pending paint is delegated — the host must actually hand it down.
    expect(src).toMatch(/loading=\{loading\}/);
  });
});

describe('the doors classify connectivity without borrowing the sections’ vocabulary', () => {
  it.each(DOORS)('%s tells offline apart from a refusal', (name) => {
    // SignIn maps connectivity to COPY.unreachable; ConsoleSignIn asks
    // isConnectivity directly. Both are the same guarantee.
    expect(read(name)).toMatch(/isConnectivity|unreachable/);
  });

  it.each(DOORS)('%s does not render SectionError', (name) => {
    expect(read(name)).not.toContain('SectionError');
  });
});

describe('a pending screen does not announce a zero it is not painting', () => {
  /**
   * The regression pin for the sr-only caption defect. Both audit screens
   * withhold the total from the <caption> while pending; the visible count line
   * does the same. `?? 0` may exist — it is the fallback AFTER data lands — but
   * the caption must not interpolate a total unguarded.
   */
  /**
   * WHITESPACE-NORMALISED, AND THAT IS A CORRECTION THIS PIN EARNED. It used to
   * match the literal `isPending ? ''`, and it FAILED on a change that did not
   * touch the guarantee at all: making the caption say "1 entry" instead of "1
   * entries" pushed the ternary onto three lines, and the pin broke while the
   * guard it protects was still exactly there.
   *
   * A source-scanning test that asserts on a SPELLING fails on formatting and
   * passes on a rewrite that keeps the words — which is the wrong way round, and
   * the house rule ("assert on the thing, not the string") applied to the census
   * itself. Collapsing whitespace keeps it strict about the construct and blind to
   * the line breaks: deleting the guard, or interpolating `total` unguarded, still
   * fails.
   */
  it.each(['AuditLog.tsx', 'console/Audit.tsx'])('%s guards its caption count', (name) => {
    const src = read(name);
    const caption = src.slice(src.indexOf('<caption'), src.indexOf('</caption>'));
    expect(caption.replace(/\s+/g, '')).toContain("isPending?''");
  });

  /**
   * The same class, in a VISIBLE heading rather than an sr-only caption.
   *
   * The design draws "Topics · {n}". `topics.length` on an undefined list needs a
   * `?? 0` to compile, and the result is "Topics · 0" announced beside a column of
   * skeletons — an empty support configuration claimed while the real one is still
   * in flight. The guard withholds the number, not the word.
   *
   * Asserts on the construct and not on the spelling, per the correction above:
   * the count must sit on the far side of a pending check.
   */
  it('console/SupportPanel.tsx withholds its topic count while pending', () => {
    const src = read('console/SupportPanel.tsx').replace(/\s+/g, '');
    expect(src).toContain("isPending?'Topics'");
    /*
     * The count reaches a STRING in exactly one place, and that place is the
     * guarded arm above.
     *
     * THIS ASSERTION WAS `/topics\.length\}/g` HAVING LENGTH 1 AND IT WAS WRONG,
     * in the direction this file already warns about twice — it asserted on a
     * spelling rather than on the thing. `}` terminates a JSX prop as readily as a
     * template interpolation, so passing `count={…topics.length}` down to the row
     * component tripped it while the guarantee was untouched: a legitimate second
     * READ of the length, not a second ANNOUNCEMENT of it. Matching the interpolated
     * label instead distinguishes the two, and still fails if the guard is deleted.
     */
    expect(src.match(/`Topics·\$\{/g) ?? []).toHaveLength(1);
  });
});

/**
 * A CAPPED LIST SAYS SO. The sibling of the premature-zero class above, and the
 * one this lane has already paid for once.
 *
 * `GET /salons/{id}/bookings` was `LIMIT 200` with a hardcoded
 * `nextCursor: null`, and this lane's `BranchesPanel` believed it: on 211
 * further-out bookings the client-side closure impact reported 0 deposit-held
 * appointments where the server's preview correctly reported 3 — because the
 * order is DESC, so the rows dropped first were the ones starting soonest. The
 * screen stated its answer with the same confidence either way.
 *
 * `GET /v1/salons/{id}/orders` is the same cap, and lane A made it honest instead
 * of hiding it: `truncated: true` when the 200-row cap was reached, named in the
 * code as "a cap, said out loud". Honest on the wire is worth nothing if the
 * client drops it, which is exactly the shape the earlier defect took — so this
 * pins that the field reaches the paint.
 *
 * WHY A SOURCE SCAN AND NOT A RENDER TEST: this file's own reason, unchanged —
 * there is no renderer in this workspace for the census, and the guarantee is
 * "the field is consulted and drawn", not "a component draws a value correctly".
 * `shopRender.test.tsx` renders the notice itself and asserts its words.
 */
describe('a capped list does not report itself as complete', () => {
  it('ShopOrders.tsx reads `truncated` and renders a notice from it', () => {
    const src = read('ShopOrders.tsx');
    // The field is actually consulted — not just present in a comment.
    expect(stripComments(src)).toContain('truncated');
    // …and it drives something drawn, rather than being read and dropped.
    expect(stripComments(src)).toMatch(/truncated\s*\?\s*<TruncatedNotice/);
  });

  /**
   * `nextCursor` IS NOT A CURSOR HERE and must not be wired to paging. The API
   * sends it always-null beside the honest `truncated`, and a client that grew a
   * "load more" off it would reintroduce the believed-null defect from the other
   * side. The type declares it `null`; this pins that nothing pages on it.
   */
  it('ShopOrders.tsx does not page on the always-null nextCursor', () => {
    expect(stripComments(read('ShopOrders.tsx'))).not.toContain('nextCursor');
  });

  /**
   * THE SAME CLASS, ON A SURFACE WHERE SAYING SO IS NOT ENOUGH.
   *
   * `ShopOrders.tsx` renders its cap as a NOTICE over a board that is still
   * useful truncated — a list of the most recent 200 orders reads as exactly
   * that. A week grid cannot do the same trick: a notice above a grid missing
   * its Thursday afternoon does not stop the Thursday afternoon looking free,
   * because nothing on the grid distinguishes "nobody booked this hour" from
   * "we did not read this hour". So the week REFUSES TO DRAW, and these pin that
   * the refusal is wired rather than merely written down.
   *
   * The render test asserts the refusal's CONTENT and mutation-checks the rule
   * itself; what a source scan adds is that no future edit reaches the grid
   * without passing the check first.
   */
  it('AppointmentsWeek.tsx consults the coverage rule before it draws', () => {
    const src = stripComments(read('AppointmentsWeek.tsx'));
    expect(src).toContain('windowCoverage');
    expect(src).toMatch(/coverage\.kind === 'walking'/);
    expect(src).toMatch(/coverage\.kind === 'short'/);
    // Both incomplete arms return BEFORE the grid is reached.
    expect(src.indexOf('<WeekGrid')).toBeGreaterThan(src.indexOf("coverage.kind === 'short'"));
    expect(src.indexOf("coverage.kind === 'short'")).toBeGreaterThan(-1);
  });

  /**
   * EXHAUSTION IS A FACT ON THE WIRE, NOT A DERIVED FLAG. TanStack's
   * `hasNextPage` is false before the first page lands, so reading it as "the
   * stream ran out" makes a pending screen claim a complete window — "Nothing
   * booked this week" painted over a week nobody has looked at. Asserts on where
   * the value COMES FROM rather than on its spelling, per this file's standing
   * correction.
   */
  it('AppointmentsWeek.tsx reads exhaustion off the payload, not off hasNextPage', () => {
    const src = stripComments(read('AppointmentsWeek.tsx'));
    expect(src).toMatch(/exhausted:[^,\n]*nextCursor/);
    expect(src).not.toMatch(/exhausted:[^,\n]*hasNextPage/);
  });
});
