import { useEffect } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Button } from '@avo/ui';
import { useAuth, useSession } from '../auth/AuthProvider.js';
import { ROLE_LABEL } from '../api/platformAdmins.js';
import { CONSOLE_NAV_ITEMS, consoleNavItemFor } from './consoleNavItems.js';
import { SCOPES } from '../auth/scopes.js';
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
 * THE QUOTATION IS §2's, VERBATIM, AND IT IS SUPERSEDED. `#6E7F6C` is the
 * retired sage — the spec was written against the 8%-saturation ramp. The rule
 * it justifies is unchanged and still correct (#A9BBA6 is 8.48:1 on #1C1B19),
 * but the measurement no longer describes the shipped brand, which now reads
 * 4.87:1 there. Kept as written rather than silently re-hexed: quoting a spec
 * and quoting it accurately are the same obligation, and `app.css` § owner
 * console carries the same note beside the same sentence.
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
/**
 * THE GUARD HALF, and it was missing.
 *
 * `MerchantShell` is split in two and its own comment says why: "`requireScope`
 * guards ENTRY to this route, but it does not re-run when the session disappears
 * underneath a mounted shell — and that is exactly what sign-out does, and what a
 * sign-out in a second tab does." This shell was written as a SIBLING of that one
 * and did not copy the one structural thing that comment exists to explain.
 *
 * The consequence was reproducible on the first try: pressing Sign out in the
 * owner console cleared the session from the tree, `useSession('owner')` threw
 * `No owner session. This route must sit behind requireScope().`, and the admin
 * got the router's CatchBoundary — "Something went wrong!" — instead of the
 * sign-in screen. The merchant dashboard lands correctly, from the same click, on
 * the same session store.
 *
 * `signOut` deletes the session from React state BEFORE awaiting the server, on
 * purpose ("the shell must leave immediately"), so there is no ordering fix on
 * that side; the shell has to tolerate a sessionless render. The split is also
 * what keeps `useSession('owner')` strict in the body — a throw is how
 * `OwnerSession` stays non-optional and how the console avoids the `??` default
 * that `useSalonId`'s header warns about.
 */
export function ConsoleShell() {
  const session = useAuth().sessionFor('owner');
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) void navigate({ to: SCOPES.owner.signIn });
  }, [session, navigate]);

  /*
   * Nothing for the tick before the redirect lands, rather than a console with no
   * admin in it. The null also unmounts <Outlet>, so Approvals and Admins never
   * render against a missing session either — both read the session or its
   * sections, and Admins reads `adminId` to decide whose row cannot be removed.
   */
  if (!session) return null;

  return <SignedInConsole />;
}

function SignedInConsole() {
  const session = useSession('owner');
  const { signOut } = useAuth();
  const breakpoint = useBreakpoint();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = consoleNavItemFor(pathname);

  if (breakpoint === 'unsupported') return <UnsupportedWidth />;

  /*
   * A section is offered when the admin HOLDS IT — that is the whole filter, and
   * `built` is not part of it. `built` drives `aria-disabled` on the link below,
   * so an unbuilt section is listed and announced as unavailable rather than
   * hidden; the design's sidebar draws all ten.
   *
   * (The previous note here claimed this filter checked `built` too, and that
   * Analytics "has no endpoint to call". Neither was true — the filter is the one
   * line below it, and `GET /v1/platform/metrics` has existed since
   * platformConsole.ts:154. A comment that describes its own adjacent code
   * wrongly is the same defect class as the gate mismatch this shell just had.)
   *
   * THE COURTESY IS ONLY AS GOOD AS THE SECTION NAMED. This reads whatever
   * `item.section` says, so a wrong section here silently mis-filters the whole
   * sidebar — it cannot tell a right answer from a stale one. That is enforced one
   * level up, in `consoleNavGates.test.ts`, against the real routes.
   *
   * Still a courtesy and not a control (#7): every one of these endpoints refuses
   * on its own.
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
            {/*
              "Founder · Owner", verbatim — `AVO Owner Console.dc.html`'s sidebar
              footer draws a TITLE and a ROLE, not one word. This line rendered
              "Founder" alone for the owner and the raw lowercase enum value
              ("analyst") for everybody else, which is not copy from anywhere.

              It is the residue of the `founder`/`owner` mismatch: the ENUM was
              corrected to `owner` in auth/platformAdmin.ts and the LABEL that had
              borrowed the design's other word was never revisited. Both questions
              were already settled and only this line disagreed with both — the
              API's enum wins on the wire, the design's words win on the screen.
            */}
            <span className="console-sidebar__whorole">
              {session.owner ? 'Founder · Owner' : ROLE_LABEL[session.role]}
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
