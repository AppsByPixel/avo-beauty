import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useSalon } from '../api/salon.js';
import { useAuth } from '../auth/AuthProvider.js';
import { SCOPES } from '../auth/scopes.js';
import { FALLBACK_SALON_ID } from '../config.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { UnsupportedWidth } from './UnsupportedWidth.js';
import { navItemFor } from './navItems.js';
import { useBrandTheme } from './useBrandTheme.js';
import { useBreakpoint } from './useBreakpoint.js';

export function MerchantShell() {
  /*
   * Read the session leniently, not through `useSession`.
   *
   * `requireScope` guards ENTRY to this route, but it does not re-run when the
   * session disappears underneath a mounted shell — and that is exactly what
   * sign-out does. `signOut()` sets state, React re-renders this component
   * while the URL is still `/overview`, and the strict accessor threw "No
   * merchant session" before `navigate` had a chance to move. The throw landed
   * in the router's CatchBoundary, so every sign-out tore the tree down through
   * an error boundary instead of simply leaving.
   *
   * The same holds for a session cleared in another tab on a shared front-desk
   * machine. A signed-out shell is a normal transient state, not a crash.
   */
  const { signOut, sessionFor } = useAuth();
  const session = sessionFor('merchant');
  const navigate = useNavigate();
  const breakpoint = useBreakpoint();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLDivElement>(null);

  const salonId = session?.salonId ?? FALLBACK_SALON_ID;
  const salonQuery = useSalon(salonId, session?.token ?? null, session !== null);
  const salon = salonQuery.data;
  const salonName = salon?.name ?? '—';
  const branchLabel = salon?.branches[0]?.name ?? '—';
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

  /*
   * The session went away under a mounted shell. `requireScope` only guards
   * entry, so the redirect has to be driven from here.
   */
  useEffect(() => {
    if (!session) void navigate({ to: SCOPES.merchant.signIn });
  }, [session, navigate]);

  // Render nothing for the tick before the redirect lands, rather than a shell
  // with no user in it. Returning null also unmounts <Outlet>, so the section
  // below never renders against a missing session either.
  if (!session) return null;

  if (breakpoint === 'unsupported') return <UnsupportedWidth />;

  const collapsed = breakpoint === 'narrow';

  function onSignOut() {
    signOut('merchant');
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
