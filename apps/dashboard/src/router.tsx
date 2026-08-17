import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { AuthState } from './auth/AuthProvider.js';
import { SCOPES, type AuthScope } from './auth/scopes.js';
import { NotBuiltYet } from './routes/NotBuiltYet.js';
import { Overview } from './routes/Overview.js';
import { SignIn } from './routes/SignIn.js';
import { Team } from './routes/Team.js';
import { MerchantShell } from './shell/MerchantShell.js';
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
  { path: '/team', component: Team },
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

const routeTree = rootRoute.addChildren([
  signInRoute,
  merchantRoute.addChildren([indexRoute, ...sectionRoutes, ...placeholderRoutes]),
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
