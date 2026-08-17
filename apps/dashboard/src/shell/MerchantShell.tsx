import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useSalon } from '../api/salon.js';
import { useAuth, useSession } from '../auth/AuthProvider.js';
import { SCOPES } from '../auth/scopes.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { UnsupportedWidth } from './UnsupportedWidth.js';
import { navItemFor } from './navItems.js';
import { useBrandTheme } from './useBrandTheme.js';
import { useBreakpoint } from './useBreakpoint.js';

/**
 * The guard half of the shell.
 *
 * `requireScope` guards ENTRY to this route, but it does not re-run when the
 * session disappears underneath a mounted shell — and that is exactly what
 * sign-out does, and what a sign-out in a second tab does. So the redirect is
 * driven from here, and the signed-in body is a separate component.
 *
 * The split is what lets the body use `useSession` and `useSalonId` strictly.
 * Those accessors throw without a session, on purpose — that is how the salon id
 * stays non-optional and how the old `?? FALLBACK_SALON_ID` cannot come back.
 * Keeping every one of them below this early return means a signed-out shell is
 * a normal transient state rather than a throw into the router's CatchBoundary.
 */
export function MerchantShell() {
  const session = useAuth().sessionFor('merchant');
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) void navigate({ to: SCOPES.merchant.signIn });
  }, [session, navigate]);

  // Render nothing for the tick before the redirect lands, rather than a shell
  // with no user in it. Returning null also unmounts <Outlet>, so the section
  // below never renders against a missing session either.
  if (!session) return null;

  return <SignedInShell />;
}

function SignedInShell() {
  const session = useSession('merchant');
  const { signOut } = useAuth();
  const breakpoint = useBreakpoint();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLDivElement>(null);

  // No salon id is passed or defaulted: the hook reads it from the session.
  const salonQuery = useSalon();
  const salon = salonQuery.data;
  const salonName = salon?.name ?? '—';
  /*
   * `?.` on `branches` too, not only on `salon`.
   *
   * `Salon.branches` is required by the type, so this read looked safe. It is
   * not: `PATCH /salons/{id}` returns the raw row with no `branches` key, and a
   * response that is typed as a Salon but is not one put `undefined` here and
   * took the whole shell to its error boundary — from a settings toggle three
   * components away. The client no longer caches that response (api/settings.ts),
   * and the shell no longer trusts a required field to be present either.
   */
  const branchLabel = salon?.branches?.[0]?.name ?? '—';
  useBrandTheme(salon?.brandColor);

  const item = navItemFor(pathname);
  const title = item?.title ?? 'Overview';
  const subtitle = (item?.subtitle ?? '').replace('{salon}', salonName);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The drawer only exists at `tablet`. Leaving that width must not strand it open.
  useEffect(() => {
    if (breakpoint !== 'tablet') setDrawerOpen(false);
  }, [breakpoint]);

  // interaction-spec.md §2: Esc closes; focus returns to the trigger.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        menuButtonRef.current?.querySelector('button')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (breakpoint === 'unsupported') return <UnsupportedWidth />;

  const collapsed = breakpoint === 'narrow';

  /*
   * Sign-out revokes the session row server-side before clearing this machine.
   * The promise is deliberately not awaited here: `signOut` drops the session
   * from the tree first, so the redirect happens on the click and the revoke
   * lands behind it. A merchant does not wait on a network round-trip to leave.
   */
  function onSignOut() {
    void signOut('merchant');
  }

  return (
    <div className="dash" data-bp={breakpoint}>
      {breakpoint === 'tablet' ? null : (
        <aside className="dash__rail" aria-label="Workspace navigation">
          <Sidebar
            salonName={salonName}
            brandHex={salon?.brandColor ?? null}
            userName={session.displayName || session.username}
            userRole="Owner"
            collapsed={collapsed}
          />
        </aside>
      )}

      <div className="dash__main">
        <div ref={menuButtonRef}>
          <Header
            title={title}
            subtitle={subtitle}
            salonName={salonName}
            branchLabel={branchLabel}
            menuOpen={drawerOpen}
            onSignOut={onSignOut}
            {...(breakpoint === 'tablet'
              ? { onOpenMenu: () => setDrawerOpen((open) => !open) }
              : {})}
          />
        </div>

        <main className="dash__content">
          <div className="dash__column">
            <Outlet />
          </div>
        </main>
      </div>

      {breakpoint === 'tablet' && drawerOpen ? (
        <>
          <div className="dash__scrim" onClick={closeDrawer} />
          <div id="dash-drawer" className="dash__drawer" role="dialog" aria-label="Sections">
            <Sidebar
              salonName={salonName}
              brandHex={salon?.brandColor ?? null}
              userName={session.displayName || session.username}
              userRole="Owner"
              collapsed={false}
              onNavigate={closeDrawer}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
