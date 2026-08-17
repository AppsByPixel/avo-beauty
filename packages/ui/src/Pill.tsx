import type { ReactNode } from 'react';

/**
 * The tones the design's static pills come in.
 *
 * TOKEN NOTE — two of these are the closest *named* token to a design value that
 * has none of its own, and the substitution is recorded here rather than
 * silently made:
 *
 *   brand    exact.   `--avo-brand-tint` on `--avo-brand-deep`.  (audit: Money)
 *   danger   exact.   `--avo-danger-bg`  on `--avo-danger-text`. (audit: Risk)
 *   warn     PARTIAL. The design paints the Access pill #EAE2D6 / #8a6d3b. The
 *            text is exactly `--avo-warn-text`; the background is not
 *            `--avo-warn-bg` (#F3E9CF) but `plan.pro.bg`, which is a *plan
 *            badge* token and means something else. Using it here would say an
 *            audit row is a subscription tier.
 *   neutral  PARTIAL. The design paints the Rules pill #ECEEF0 / #5f6b73, which
 *            are `tier.silver.pillBg` / `tier.silver.pillText` — a *loyalty
 *            tier* token. Same objection.
 *
 * Neither has a colour token naming what it is, and neither is invented here.
 * Both are reported to trunk; until a token lands, the nearest semantically
 * honest pair is used and the pill still reads correctly.
 */
export type PillTone = 'brand' | 'neutral' | 'warn' | 'danger' | 'quiet';

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  /** A leading dot. Decoration only — the label always carries the meaning. */
  dot?: boolean;
  className?: string;
}

/**
 * A static status pill: the audit log's kind column, "Synced" / "Off" on a
 * Google-sourced day, "Google Calendar" / "Manual hours" on an artist card.
 *
 * Not a button and not focusable. Anything clickable is a `Chip`.
 */
export function Pill({ tone = 'quiet', children, dot = false, className }: PillProps) {
  return (
    <span
      className={['avo-pill', className ?? ''].filter(Boolean).join(' ')}
      data-tone={tone}
    >
      {dot ? <span className="avo-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
