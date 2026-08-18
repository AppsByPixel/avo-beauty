import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Button } from '@avo/ui';
import { useAuth, useSession } from '../auth/AuthProvider.js';
import { CONSOLE_NAV_ITEMS, consoleNavItemFor } from './consoleNavItems.js';
import { useBreakpoint } from './useBreakpoint.js';
import { UnsupportedWidth } from './UnsupportedWidth.js';

/**
 * The owner console frame. `AVO Owner Console.dc.html`, dark.
 *
 * A SIBLING OF `MerchantShell`, not a variant of it. ADR-0001 says the console is
 * "the same application with a different auth scope and shell, not a second
 * app" — the shared parts are the router, the session store, the query client,
 * the API client and every `@avo/ui` primitive. What is not shared is the frame,
 * because the two have different navs, different section models
 * (`perms` vs `sections`) and different colour ground.
 *
 * `avo-dark` on the root is what switches the focus ring: `@avo/tokens` emits
 * `.avo-dark :focus-visible { outline-color: #A9BBA6 }` because
 * interaction-spec.md §2 says `#6E7F6C` "does not carry enough contrast against
 * #1C1B19". That token existed before this shell did and had nothing to apply to.
 *
 * THE SIDEBAR HIDES WHAT THE ADMIN CANNOT REACH, AND THAT IS A COURTESY. Every
 * one of the nine sections is enforced by `requirePlatform` server-side, so a
 * hidden item is a convenience and a shown one is not a grant — #7. An analyst
 * who bookmarks `/console/approvals` gets the server's 403 rendered as an
 * explain-state, not a blank screen.
 *
 * The same width rule as the merchant shell: below 768px this is not a supported
 * surface (interaction-spec.md §1), and that is the design rather than a gap.
 */
export function ConsoleShell() {
  const session = useSession('owner');
  const { signOut } = useAuth();
  const breakpoint = useBreakpoint();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = consoleNavItemFor(pathname);

  if (breakpoint === 'unsupported') return <UnsupportedWidth />;

  /*
   * A section is offered when the admin holds it AND it is built. `built` and
   * `section` are separate facts: Analytics is gated by a real permission the
   * admin may well hold, and still has no endpoint to call, so offering it would
   * be a link to a screen that cannot load.
   */
  const visible = CONSOLE_NAV_ITEMS.filter(
    (item) => item.section === null || session.sections[item.section],
  );

  return (
    <div className="console avo-dark" data-bp={breakpoint}>
      <nav className="console-sidebar" aria-label="Console sections">
        <div className="console-sidebar__brand">
          <span className="console-sidebar__mark" aria-hidden="true">
            A
          </span>
          <span>
            <span className="console-sidebar__name avo-display">AVO Platform</span>
            <span className="console-sidebar__sub">Owner console</span>
          </span>
        </div>

        <ul className="console-sidebar__list">
          {visible.map((item) => (
            <li key={item.id}>
              <Link
                to={item.to}
                className="console-navitem"
                activeProps={{ className: 'console-navitem console-navitem--on' }}
                aria-disabled={item.built ? undefined : true}
              >
                <span className="console-navitem__icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="console-navitem__label">{item.label}</span>
                {item.built ? null : (
                  /* Named rather than silently missing — see NotBuiltYet. */
                  <span className="console-navitem__soon">soon</span>
                )}
              </Link>
            </li>
          ))}
        </ul>

        <div className="console-sidebar__foot">
          <span className="console-sidebar__who">
            <span className="console-sidebar__whoname">{session.displayName}</span>
            <span className="console-sidebar__whorole">
              {session.owner ? 'Founder' : session.role}
            </span>
          </span>
        </div>
      </nav>

      <div className="console-main">
        <header className="console-header">
          <div>
            <h1 className="console-header__title avo-display">{current?.title ?? 'Console'}</h1>
            <p className="console-header__sub">{current?.subtitle ?? ''}</p>
          </div>
          <Button variant="quiet" onClick={() => void signOut('owner')}>
            Sign out
          </Button>
        </header>
        <main className="console-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
