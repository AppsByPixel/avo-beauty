import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { AuthState } from './auth/AuthProvider.js';
import { SCOPES, type AuthScope } from './auth/scopes.js';
import { isSessionEndReason, signInSearchFor, type SignInSearch } from './auth/signInSearch.js';
import { Accounts } from './routes/Accounts.js';
import { ConsoleAccounts } from './routes/console/Accounts.js';
import { Activity } from './routes/console/Activity.js';
import { Admins } from './routes/console/Admins.js';
import { Analytics } from './routes/console/Analytics.js';
import { Audit } from './routes/console/Audit.js';
import { Approvals } from './routes/console/Approvals.js';
import { Controls } from './routes/console/Controls.js';
import { ConsoleSignIn } from './routes/ConsoleSignIn.js';
import { Policies } from './routes/console/Policies.js';
import { Salons } from './routes/console/Salons.js';
import { SalonEditor } from './routes/console/SalonEditor.js';
import { Appointments } from './routes/Appointments.js';
import { AuditLog } from './routes/AuditLog.js';
import { Loyalty } from './routes/Loyalty.js';
import { Marketing } from './routes/Marketing.js';
import { NotBuiltYet } from './routes/NotBuiltYet.js';
import { Overview } from './routes/Overview.js';
import { Reports } from './routes/Reports.js';
import { Settings } from './routes/Settings.js';
import { Shop } from './routes/Shop.js';
import { SignIn } from './routes/SignIn.js';
import { Team } from './routes/Team.js';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { MerchantShell } from './shell/MerchantShell.js';
import { CONSOLE_NAV_ITEMS } from './shell/consoleNavItems.js';
import { NAV_ITEMS } from './shell/navItems.js';

export interface RouterContext {
  auth: AuthState;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

/**
 * One guard, parameterised by scope. The owner console gets its own layout route
 * with `requireScope('owner')` and its own shell; it does not get a second
 * router, a second session store or a second sign-in flow. ADR-0001.
 */
function requireScope(scope: AuthScope) {
  return ({ context, location }: { context: RouterContext; location: { pathname: string } }) => {
    if (!context.auth.sessionFor(scope)) {
      /*
       * ==============================================================
       * THE GUARD'S BOUNCE CARRIES A DESTINATION TOO
       * ==============================================================
       * This was a bare `redirect({ to: signIn })`, and it is the ONE DOOR THE
       * SHELL CANNOT COVER. `MerchantShell` preserves the section she was on by
       * reading it as it redirects — but a merchant who opens a bookmarked
       * `/appointments` with no session never mounts the shell at all, because
       * this runs first and refuses. However good that redirect gets, this path
       * would still have landed her on `/overview`.
       *
       * So it is rebuilt HERE from the same function the shells use, which means
       * the two paths cannot disagree about where she came from or how the
       * search is spelled. `location.pathname` is the route being entered.
       *
       * `endedReasonFor` is read off the context this guard was handed, so a
       * session that ended while a section was mounted still explains itself if
       * the guard happens to be what notices. On a cold arrival it is null and
       * nothing is claimed — a bookmark is not an expiry, and telling somebody
       * who simply opened a link that her session ran out would be a sentence
       * about an event that did not happen.
       *
       * The path is gated by `returnPathFor` inside `signInSearchFor` — the same
       * closed set as everywhere else, so a `/appointments` typed by anyone is
       * still resolved to this app's own literal before it reaches a URL.
       */
      throw redirect({
        to: SCOPES[scope].signIn,
        search: signInSearchFor(scope, location.pathname, context.auth.endedReasonFor(scope)),
      });
    }
  };
}

/**
 * WHAT A SIGN-IN SCREEN ACCEPTS IN ITS QUERY STRING, declared once for both doors.
 *
 * `from` is the section the shell was showing when the session ended and
 * `reason` is why, as a category. Both are written by `signInSearchFor` and read
 * back by the screen — see `auth/signInSearch.ts` for the whole argument.
 *
 * THIS PARSER IS NOT THE SECURITY GATE, AND SAYING SO IS THE POINT. `reason` is
 * narrowed to the two words here because an unknown one has no meaning to carry
 * and no screen would render it. `from` is deliberately passed through as a
 * plain string: the check that matters — that a destination is one of this
 * shell's own sections — lives at the point of navigation, where it cannot be
 * bypassed by a caller that assembles the search some other way.
 *
 * Two gates would be worse than one. The rule drifts between the copies, and a
 * spec that exercises the gate it is not aiming at passes for the wrong reason —
 * which is precisely the failure the return-path specs mutate to rule out.
 */
function validateSignInSearch(search: Record<string, unknown>): SignInSearch {
  return {
    ...(typeof search['from'] === 'string' ? { from: search['from'] } : {}),
    ...(isSessionEndReason(search['reason']) ? { reason: search['reason'] } : {}),
  };
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SCOPES.merchant.signIn,
  component: SignIn,
  validateSearch: validateSignInSearch,
});

/**
 * The merchant shell. A pathless layout route, so every section below it is
 * guarded and framed without carrying a prefix in the URL — and so the console's
 * `/console` layout can sit beside it as a sibling rather than a fork.
 */
const merchantRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'merchant',
  beforeLoad: requireScope('merchant'),
  component: MerchantShell,
});

const indexRoute = createRoute({
  getParentRoute: () => merchantRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: SCOPES.merchant.home });
  },
});

/**
 * The built sections, keyed by the nav path they answer.
 *
 * Paired with `NAV_ITEMS[].built` rather than listed twice: the placeholder
 * routes below are derived from the same flag, so a section that is built and a
 * section the sidebar *says* is built cannot drift apart. Adding a section is
 * one component here and one `built: true` there.
 */
const SECTIONS = [
  { path: '/overview', component: Overview },
  { path: '/appointments', component: Appointments },
  { path: '/team', component: Team },
  { path: '/loyalty', component: Loyalty },
  { path: '/marketing', component: Marketing },
  { path: '/settings', component: Settings },
  { path: '/accounts', component: Accounts },
  { path: '/shop', component: Shop },
  { path: '/audit', component: AuditLog },
  { path: '/reports', component: Reports },
] as const;

const sectionRoutes = SECTIONS.map(({ path, component }) =>
  createRoute({ getParentRoute: () => merchantRoute, path, component }),
);

/**
 * Every other nav item resolves to a route, so the sidebar never dead-ends.
 *
 * THIS LIST IS EMPTY TODAY, and it is kept rather than deleted. Shop was the last
 * `built: false` row in `shell/navItems.tsx`, so every merchant nav item now has a
 * component of its own — the derivation is what guarantees that stays true, and
 * deleting it would mean the next unbuilt section 404s instead of explaining
 * itself. The console's equivalent below is still non-empty (`/console/billing`).
 */
const placeholderRoutes = NAV_ITEMS.filter((item) => !item.built).map((item) =>
  createRoute({
    getParentRoute: () => merchantRoute,
    path: item.to,
    component: () => <NotBuiltYet section={item.title} scope="merchant" />,
  }),
);

/**
 * THE OWNER CONSOLE, as a SIBLING of the merchant shell rather than a fork.
 *
 * This is what `auth/scopes.ts` has been structured for since the first slice:
 * "Adding the console means adding the `owner` rows below, a shell component, and
 * its routes under `/console` — not a second sign-in flow, a second session store,
 * or a second router." That held. `requireScope` is the same guard with a
 * different argument, `SCOPES.owner` already carried the paths and the dark theme
 * flag, and the two sessions coexist because `writeSession` keys storage per
 * scope.
 */
const consoleSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SCOPES.owner.signIn,
  component: ConsoleSignIn,
  // The same shape as the merchant door's, from the same function. The two
  // sign-in screens must not diverge on how a session ending is explained.
  validateSearch: validateSignInSearch,
});

const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'console',
  beforeLoad: requireScope('owner'),
  component: ConsoleShell,
});

const consoleIndexRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: SCOPES.owner.prefix,
  beforeLoad: () => {
    throw redirect({ to: SCOPES.owner.home });
  },
});

/** Built console sections, paired with `CONSOLE_NAV_ITEMS[].built` for the same
 *  reason the merchant ones are: a section that is built and a sidebar that says
 *  so cannot drift apart. */
const CONSOLE_SECTIONS = [
  /*
   * `ConsoleAccounts`, not `Accounts` — `routes/Accounts.tsx` is the MERCHANT's
   * team screen and is already imported above under that name. Two different
   * screens on two different surfaces, reading two different endpoints behind two
   * different guards (`perms.team` on her own salon vs `requirePlatform(req,
   * 'accounts')` across every tenant), which happen to share the design's word.
   * The import is renamed at its source rather than aliased here, so the console
   * component cannot be pulled into the merchant tree by autocomplete.
   */
  { path: '/console/accounts', component: ConsoleAccounts },
  { path: '/console/activity', component: Activity },
  { path: '/console/admins', component: Admins },
  { path: '/console/analytics', component: Analytics },
  { path: '/console/audit', component: Audit },
  { path: '/console/approvals', component: Approvals },
  { path: '/console/controls', component: Controls },
  { path: '/console/policies', component: Policies },
  { path: '/console/salons', component: Salons },
] as const;

const consoleSectionRoutes = CONSOLE_SECTIONS.map(({ path, component }) =>
  createRoute({ getParentRoute: () => consoleRoute, path, component }),
);

/**
 * The per-salon editor. `AVO Owner Console.dc.html:400` § "salon editor" — the
 * second half of a section the design describes as "list → per-salon editor".
 *
 * DECLARED ON ITS OWN RATHER THAN ADDED TO `CONSOLE_SECTIONS`, AND NOT BY
 * PREFERENCE. It was in that table first. `.map()` over a mixed tuple gives every
 * route it builds the UNION of the tuple's path types, and a union containing one
 * parameterised path makes `params` REQUIRED on all of them — so
 * `<Link to="/console/salons">` in the editor's own back button stopped compiling,
 * asking for an `id` the salons LIST does not take. The table stays homogeneous
 * and the one param route is built beside it.
 *
 * IT IS STILL AUDITED. `routes/stateCensus.test.ts` no longer reads the two
 * `SECTIONS` tables — it scans this whole file for every `component:` a route
 * mounts, precisely so a route declared outside a table cannot skip the
 * four-states classification. That change was made with this route, because this
 * route is the first one that would have slipped through.
 *
 * No sidebar item is needed: `consoleNavItemFor` matches on
 * `startsWith(`${item.to}/`)`, so the console header keeps saying Salons while the
 * editor is open. The design does the same — its editor is a sub-view of the
 * section, not a tenth destination.
 */
const consoleSalonEditorRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/console/salons/$id',
  component: SalonEditor,
});

/** Every other console nav item resolves, so the sidebar never dead-ends. */
const consolePlaceholderRoutes = CONSOLE_NAV_ITEMS.filter((item) => !item.built).map((item) =>
  createRoute({
    getParentRoute: () => consoleRoute,
    path: item.to,
    component: () => <NotBuiltYet section={item.title} scope="owner" />,
  }),
);

const routeTree = rootRoute.addChildren([
  signInRoute,
  consoleSignInRoute,
  merchantRoute.addChildren([indexRoute, ...sectionRoutes, ...placeholderRoutes]),
  consoleRoute.addChildren([
    consoleIndexRoute,
    ...consoleSectionRoutes,
    consoleSalonEditorRoute,
    ...consolePlaceholderRoutes,
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { auth: undefined as unknown as AuthState },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
