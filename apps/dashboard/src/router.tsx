import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { AuthState } from './auth/AuthProvider.js';
import { SCOPES, type AuthScope } from './auth/scopes.js';
import { Accounts } from './routes/Accounts.js';
import { Admins } from './routes/console/Admins.js';
import { Analytics } from './routes/console/Analytics.js';
import { Audit } from './routes/console/Audit.js';
import { Approvals } from './routes/console/Approvals.js';
import { Controls } from './routes/console/Controls.js';
import { ConsoleSignIn } from './routes/ConsoleSignIn.js';
import { Policies } from './routes/console/Policies.js';
import { Appointments } from './routes/Appointments.js';
import { AuditLog } from './routes/AuditLog.js';
import { Loyalty } from './routes/Loyalty.js';
import { Marketing } from './routes/Marketing.js';
import { NotBuiltYet } from './routes/NotBuiltYet.js';
import { Overview } from './routes/Overview.js';
import { Settings } from './routes/Settings.js';
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
  return ({ context }: { context: RouterContext }) => {
    if (!context.auth.sessionFor(scope)) {
      throw redirect({ to: SCOPES[scope].signIn });
    }
  };
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SCOPES.merchant.signIn,
  component: SignIn,
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
  { path: '/audit', component: AuditLog },
] as const;

const sectionRoutes = SECTIONS.map(({ path, component }) =>
  createRoute({ getParentRoute: () => merchantRoute, path, component }),
);

/** Every other nav item resolves to a route, so the sidebar never dead-ends. */
const placeholderRoutes = NAV_ITEMS.filter((item) => !item.built).map((item) =>
  createRoute({
    getParentRoute: () => merchantRoute,
    path: item.to,
    component: () => <NotBuiltYet section={item.title} />,
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
  { path: '/console/admins', component: Admins },
  { path: '/console/analytics', component: Analytics },
  { path: '/console/audit', component: Audit },
  { path: '/console/approvals', component: Approvals },
  { path: '/console/controls', component: Controls },
  { path: '/console/policies', component: Policies },
] as const;

const consoleSectionRoutes = CONSOLE_SECTIONS.map(({ path, component }) =>
  createRoute({ getParentRoute: () => consoleRoute, path, component }),
);

/** Every other console nav item resolves, so the sidebar never dead-ends. */
const consolePlaceholderRoutes = CONSOLE_NAV_ITEMS.filter((item) => !item.built).map((item) =>
  createRoute({
    getParentRoute: () => consoleRoute,
    path: item.to,
    component: () => <NotBuiltYet section={item.title} />,
  }),
);

const routeTree = rootRoute.addChildren([
  signInRoute,
  consoleSignInRoute,
  merchantRoute.addChildren([indexRoute, ...sectionRoutes, ...placeholderRoutes]),
  consoleRoute.addChildren([
    consoleIndexRoute,
    ...consoleSectionRoutes,
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
