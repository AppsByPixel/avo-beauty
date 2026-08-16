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

const overviewRoute = createRoute({
  getParentRoute: () => merchantRoute,
  path: '/overview',
  component: Overview,
});

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
  merchantRoute.addChildren([indexRoute, overviewRoute, ...placeholderRoutes]),
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
