import type { ReactNode } from 'react';
import { Button } from '@avo/ui';

export interface HeaderProps {
  title: string;
  subtitle: string;
  salonName: string;
  /**
   * THE BRANCH SCOPE, AS A NODE RATHER THAN A STRING — and the type change is
   * the point of the change.
   *
   * This was `branchLabel: string`, filled by `MerchantShell` with
   * `salon?.branches?.[0]?.name ?? '—'` and rendered as `{salonName} · {label}`.
   * A multi-branch merchant read the first branch's name over salon-wide
   * figures: a specific, confident, permanently wrong claim. A `string` prop is
   * a promise that this slot is a LABEL, and no value of that string is correct
   * for a salon with two branches — the honest thing here is a control, which
   * is `BranchSelector`. `ReactNode` is what lets this component stop knowing.
   *
   * `null` is a real value and means "make no claim": the branch list is
   * unavailable or empty, and the header renders the salon alone rather than
   * inventing a scope. See `BranchSelector.tsx` § the four states.
   */
  branch: ReactNode;
  /**
   * THE NOTIFICATION BELL, AS A NODE FOR `branch`'s REASON.
   *
   * The bell polls, reads the session's salon id and decides what a reader may
   * be told - none of which this component should learn in order to draw a
   * header. `MerchantShell` passes `<NotificationBell />`; the slot stays a
   * `ReactNode` so the chrome keeps knowing nothing about permissions.
   *
   * OPTIONAL, and the omission is a real case rather than defensive typing: a
   * test rendering this header does not need a query client, and the header
   * itself must not require one.
   */
  bell?: ReactNode;
  /** Rendered only at the `tablet` breakpoint, where the sidebar is a drawer. */
  onOpenMenu?: () => void;
  menuOpen?: boolean;
  onSignOut: () => void;
}

/** "Saturday · 11 July 2026" — the format used in the design header. */
function todayLabel(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const rest = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${weekday} · ${rest}`;
}

export function Header({
  title,
  subtitle,
  salonName,
  branch,
  bell,
  onOpenMenu,
  menuOpen = false,
  onSignOut,
}: HeaderProps) {
  return (
    <header className="dash-header">
      <div className="dash-header__left">
        {onOpenMenu ? (
          <button
            type="button"
            className="dash-header__menu"
            aria-label="Open sections menu"
            aria-expanded={menuOpen}
            aria-controls="dash-drawer"
            onClick={onOpenMenu}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M3 5.5h14M3 10h14M3 14.5h14"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
        <div>
          <h1 className="dash-header__title avo-display">{title}</h1>
          <p className="dash-header__sub">{subtitle}</p>
        </div>
      </div>

      <div className="dash-header__right">
        <span className="dash-header__date">{todayLabel()}</span>
        {/*
          Between the date and the rule, which is where the design puts it
          (AVO Merchant Dashboard.dc.html:88-95) - and it stays when the date
          and the rule are hidden at the narrower breakpoints, because a bell
          that disappears on a small window is a worklist nobody is reading.
        */}
        {bell}
        <span className="dash-header__rule" aria-hidden="true" />
        {/*
          Two nodes where there was one interpolated span. The salon is a fact
          and stays a pill; the branch is a choice and is whatever
          `BranchSelector` decided it can honestly be — a segment, a name, a
          skeleton, or nothing. A `<div role="radiogroup">` also cannot live
          inside a `<span>`, so the split is required as well as right.
        */}
        <span className="dash-header__branch">{salonName}</span>
        {branch}
        <Button variant="quiet" onClick={onSignOut} className="dash-header__signout">
          Sign out
        </Button>
      </div>
    </header>
  );
}
