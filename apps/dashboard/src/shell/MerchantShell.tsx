import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useSalon } from '../api/salon.js';
import { ROLE_LABEL } from '../api/staff.js';
import { useAuth, useSession } from '../auth/AuthProvider.js';
import type { StaffRole } from '../auth/session.js';
import { SCOPES } from '../auth/scopes.js';
import { BranchScopeProvider } from './BranchScope.js';
import { BranchSelector } from './BranchSelector.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { UnsupportedWidth } from './UnsupportedWidth.js';
import { navItemFor } from './navItems.js';
import { useBrandTheme } from './useBrandTheme.js';
import { useBreakpoint } from './useBreakpoint.js';

/**
 * A merchant's own authority, as the rail prints it — the line that used to be
 * the literal "Owner" for everybody.
 *
 * EXPORTED FOR THE TEST, and the reason is the same one `appliedBranchOf` in
 * routes/Overview.tsx is exported for: the interesting behaviour is a mapping
 * with three cases, and a rendering test that has to mount a router to reach it
 * proves less about the mapping than a call does. `sidebarAuthority.test.tsx`
 * covers all five roles, the null, and the word off the end of the enum.
 */
export function authorityLabel(role: StaffRole | null): string | null {
  if (role === null) return null;
  return ROLE_LABEL[role] ?? role;
}

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
  const drawerRef = useRef<HTMLDivElement>(null);

  // No salon id is passed or defaulted: the hook reads it from the session.
  const salonQuery = useSalon();
  const salon = salonQuery.data;
  const salonName = salon?.name ?? '—';
  /*
   * THE SHELL NO LONGER COMPUTES A BRANCH LABEL, AND MUST NOT AGAIN.
   *
   * What stood here was `salon?.branches?.[0]?.name ?? '—'`, handed to the
   * header and drawn as `{salonName} · {branchLabel}`. For any salon with more
   * than one branch that named ONE branch above figures covering ALL of them —
   * the label and the numbers underneath answering different questions, which
   * is this project's signature defect and the fourteenth logged instance of it.
   *
   * The scope is now a selection rather than a derivation: `BranchScopeProvider`
   * holds it, `BranchSelector` renders the control in the space the span
   * occupied, and `routes/Overview.tsx` and `routes/Reports.tsx` read the same
   * value. There is deliberately nothing left in this file to get wrong —
   * `branchScope.test.tsx` asserts that this component never reads `branches[0]`
   * again.
   *
   * (The old comment here warned that `?.` on `branches` was load-bearing,
   * because `PATCH /salons/{id}` answers with a raw row carrying no `branches`
   * key. That hazard has not gone away, it has MOVED: `BranchScope.tsx` reads
   * `salon.data?.branches ?? []` for the same reason.)
   */
  useBrandTheme(salon?.brandColor);

  const item = navItemFor(pathname);
  const title = item?.title ?? 'Overview';
  const subtitle = (item?.subtitle ?? '').replace('{salon}', salonName);

  /*
   * Closing the drawer RETURNS FOCUS TO THE TRIGGER — every route out, not just
   * Esc. interaction-spec.md §2. A drawer that unmounts while it still holds
   * focus drops the caret on `<body>`, and the next Tab restarts from the top of
   * the document, which on this shell means the merchant tabs through the header
   * again to get back to where she was.
   */
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.querySelector('button')?.focus();
  }, []);

  // The drawer only exists at `tablet`. Leaving that width must not strand it open.
  useEffect(() => {
    if (breakpoint !== 'tablet') setDrawerOpen(false);
  }, [breakpoint]);

  /*
   * FOCUS MOVES IN, AND IS TRAPPED. interaction-spec.md §2: "Sheets and modals:
   * focus moves to the sheet on open, is **trapped** while open, and returns to
   * the trigger on close. `Esc` closes".
   *
   * The drawer already carried `role="dialog"` and already closed on Esc, so it
   * looked done. It was not, and the gap had a real consequence: with the drawer
   * open, the only tabbable elements in the document were the menu button and
   * **Sign out** — both *behind* the scrim. Tab twice on an open drawer and the
   * focus ring is sitting on an invisible Sign out, one Enter from ending the
   * session, with nothing on screen to say so. `role="dialog"` is a promise to a
   * screen reader that the rest of the page is inert; the trap is what makes the
   * promise true.
   */
  useEffect(() => {
    if (!drawerOpen) return;
    const mounted = drawerRef.current;
    if (mounted === null) return;
    // Re-bound with a non-null type so the nested handler below reads it as one.
    const drawer: HTMLDivElement = mounted;

    /*
     * `tabIndex >= 0`, not a hardcoded tag list, because the nav inside this
     * drawer uses a ROVING TABINDEX (Sidebar.tsx) — exactly one link is tabbable
     * and the arrow keys move it. So this legitimately resolves to a single
     * element, and Tab correctly cycles to itself: one tab stop for the nav,
     * arrows within it, which is what §2 asks of the sidebar.
     */
    const tabbable = () =>
      [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]')].filter(
        (el) => el.tabIndex >= 0 && el.offsetParent !== null,
      );

    // Land on the current section rather than the container, so the arrow keys
    // are live on arrival instead of after a first orienting Tab.
    (tabbable()[0] ?? drawer).focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = tabbable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        // Nothing to land on: hold the caret on the drawer rather than letting
        // it fall through to the page the scrim is covering.
        event.preventDefault();
        drawer.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

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

  /*
   * THE AUTHORITY LABEL, WHICH USED TO BE THE LITERAL "Owner" ON BOTH SIDEBARS.
   *
   * It printed "Owner" for a manager and for a front-desk account alike, on the
   * same screen where the Reports section refuses most of its cards to anyone
   * without an owner's permissions. The label contradicted the refusals sitting
   * next to it, and the refusals were the honest half.
   *
   * `ROLE_LABEL` FROM `api/staff.js`, NOT the console's map of the same name in
   * `api/platformAdmins.js`. `ConsoleShell` does the equivalent line one
   * component over and the shape here is deliberately the same, but the two maps
   * key off different enums: this one is `staff_user.role` — owner, manager,
   * frontdesk, artist, scanner, labelled the way the design's Team chips label
   * them, so `artist` reads "Stylist" — and `PlatformRole` is the four AVO staff
   * roles. They share only the word `owner`. Indexing one with the other would
   * type-check on that single value and render `undefined` for every other.
   *
   * `?? session.role` for a role the map has not heard of. `roleOptionsFor` in
   * the same module makes the same call for the same reason: showing a staff
   * member the raw enum word for her own authority is poor, but showing her
   * somebody else's authority is a defect. `null` stays `null` and draws nothing
   * — see `MerchantSession.role` for when that happens and why it is tolerated.
   */
  const userRole = authorityLabel(session.role);

  /*
   * THE PROVIDER WRAPS THE HEADER AND THE OUTLET TOGETHER, and that is the whole
   * reason it is here rather than inside a screen. The control lives in the
   * chrome and the figures it scopes live in the route below it; a provider
   * mounted in either one alone would put them back on two selections. It sits
   * under the `!session` early return with everything else that reads the
   * session, so a signed-out shell still mounts nothing.
   */
  return (
    <BranchScopeProvider>
      <div className="dash" data-bp={breakpoint}>
        {breakpoint === 'tablet' ? null : (
          <aside className="dash__rail" aria-label="Workspace navigation">
            <Sidebar
              salonName={salonName}
              brandHex={salon?.brandColor ?? null}
              userName={session.displayName || session.username}
              userRole={userRole}
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
              branch={<BranchSelector />}
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
            {/*
              Presentational. The dismiss it offers is a convenience for a pointer;
              the keyboard route out is Esc, which §2 names and the trap above
              handles, so this is not a second tab stop pretending to be a button.
            */}
            <div className="dash__scrim" aria-hidden="true" onClick={closeDrawer} />
            <div
              id="dash-drawer"
              ref={drawerRef}
              className="dash__drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Sections"
              // Focusable only as the trap's fallback landing spot, never by Tab.
              tabIndex={-1}
            >
              <Sidebar
                salonName={salonName}
                brandHex={salon?.brandColor ?? null}
                userName={session.displayName || session.username}
                userRole={userRole}
                collapsed={false}
                onNavigate={closeDrawer}
              />
            </div>
          </>
        ) : null}
      </div>
    </BranchScopeProvider>
  );
}
