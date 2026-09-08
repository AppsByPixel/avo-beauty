import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { NAV_ITEMS } from './navItems.js';

export interface SidebarProps {
  salonName: string;
  /**
   * The salon's brand hex, for the "Brand token" readout only. The swatch and
   * every fill resolve through `--avo-brand` / `--avo-brand-deep`, which
   * `useBrandTheme` has already derived from this same value.
   */
  brandHex: string | null;
  /** Signed-in user, shown at the foot of the rail. */
  userName: string;
  /**
   * Her authority, already labelled — `ROLE_LABEL['frontdesk']` is "Front desk",
   * not the wire value. NULL MEANS UNKNOWN AND DRAWS NOTHING, which is a state a
   * session read out of storage can genuinely be in; see `MerchantSession.role`.
   * A placeholder here would be the hardcoded "Owner" all over again.
   */
  userRole: string | null;
  /** narrow: icons only. tablet: rendered inside the drawer, always expanded. */
  collapsed: boolean;
  onNavigate?: () => void;
}

/**
 * interaction-spec.md §2: the sidebar is a SINGLE tab stop with arrow-key
 * movement between items. That is a roving tabindex — exactly one item is
 * tabbable, arrows move focus and the roving index with it.
 *
 * The spec suggests `role="tablist"` "where sections swap in place, which is
 * what the prototypes do". Here the sections are routes, not panels swapped in
 * place, so these stay links inside a `<nav>` with `aria-current="page"`. Tab
 * semantics on something that changes the URL misreports the widget to a screen
 * reader; the single-tab-stop keyboard behaviour — the part that actually
 * matters — is identical.
 */
export function Sidebar({
  salonName,
  brandHex,
  userName,
  userRole,
  collapsed,
  onNavigate,
}: SidebarProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeIndex = Math.max(
    0,
    NAV_ITEMS.findIndex((item) => pathname.startsWith(item.to)),
  );
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  const listRef = useRef<HTMLUListElement>(null);
  const shouldFocus = useRef(false);

  useEffect(() => {
    setFocusIndex(activeIndex);
  }, [activeIndex]);

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    const links = listRef.current?.querySelectorAll<HTMLElement>('[data-nav-link]');
    links?.[focusIndex]?.focus();
  }, [focusIndex]);

  /*
   * Functional updates, not `focusIndex + 1`. Two arrow presses inside one
   * React batch both read the same closed-over index and collapse into a single
   * step — which is exactly what a held-down arrow key does.
   */
  function move(step: number | 'first' | 'last') {
    shouldFocus.current = true;
    setFocusIndex((current) => {
      if (step === 'first') return 0;
      if (step === 'last') return NAV_ITEMS.length - 1;
      return (current + step + NAV_ITEMS.length) % NAV_ITEMS.length;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        move('first');
        break;
      case 'End':
        event.preventDefault();
        move('last');
        break;
      case ' ':
      case 'Spacebar': {
        // Enter already activates a link; Space does not. The spec asks for both.
        event.preventDefault();
        const target = NAV_ITEMS[focusIndex];
        if (target) {
          void navigate({ to: target.to });
          onNavigate?.();
        }
        break;
      }
      default:
        break;
    }
  }

  return (
    <div className="dash-sidebar">
      <div className="dash-sidebar__brand">
        {/*
          The design paints this mark with `brand` and computes a contrast text
          colour. Non-negotiable #9 does not allow that split here: a white-text
          fill uses `--avo-brand-deep`, full stop. Deliberate deviation.
        */}
        <span className="dash-sidebar__mark" aria-hidden="true">
          {salonName.charAt(0).toUpperCase()}
        </span>
        <span className="dash-sidebar__brand-text">
          <span className="dash-sidebar__salon">{salonName}</span>
          <span className="dash-sidebar__salon-sub">Salon · Kuwait</span>
        </span>
      </div>

      <nav aria-label="Sections">
        <ul className="dash-nav" ref={listRef} onKeyDown={onKeyDown}>
          {NAV_ITEMS.map((item, index) => {
            const current = index === activeIndex;
            return (
              <li key={item.id}>
                <Link
                  data-nav-link
                  to={item.to}
                  className="dash-nav__item"
                  data-current={current || undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onNavigate?.()}
                >
                  <span className="dash-nav__icon">{item.icon}</span>
                  <span className="dash-nav__label">{item.label}</span>
                  {collapsed ? <span className="dash-nav__flyout">{item.label}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="dash-sidebar__foot">
        <div className="dash-sidebar__token">
          <div className="avo-label">Brand token</div>
          <div className="dash-sidebar__token-row">
            <span className="dash-sidebar__swatch" aria-hidden="true" />
            <span className="dash-sidebar__token-value">{brandHex?.toUpperCase() ?? '—'}</span>
          </div>
        </div>
        <div className="dash-sidebar__user">
          <span className="dash-sidebar__avatar" aria-hidden="true">
            {userName.charAt(0).toUpperCase()}
          </span>
          <span className="dash-sidebar__user-text">
            <span className="dash-sidebar__user-name">{userName}</span>
            {/* Omitted rather than emptied: an empty span is a blank line of
                chrome under her name, and the foot is a flex column that closes
                up without it. */}
            {userRole === null ? null : (
              <span className="dash-sidebar__user-role">{userRole}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
