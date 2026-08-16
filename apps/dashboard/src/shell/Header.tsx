import { Button } from '@avo/ui';

export interface HeaderProps {
  title: string;
  subtitle: string;
  salonName: string;
  branchLabel: string;
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
  branchLabel,
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
        <span className="dash-header__rule" aria-hidden="true" />
        <span className="dash-header__branch">
          {salonName} · {branchLabel}
        </span>
        <Button variant="quiet" onClick={onSignOut} className="dash-header__signout">
          Sign out
        </Button>
      </div>
    </header>
  );
}
