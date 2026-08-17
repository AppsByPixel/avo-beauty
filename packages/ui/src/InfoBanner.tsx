import type { ReactNode } from 'react';

export interface InfoBannerProps {
  /** The 18px outline glyph the design puts at the left of the strip. */
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * The `--avo-brand-tint` explanatory strip that heads Team and Audit log in
 * AVO Merchant Dashboard.dc.html.
 *
 * Not `role="status"` and not `role="alert"`. This is standing prose that
 * explains how a section works — it never changes and it is not the result of
 * anything the merchant did. Announcing it on every section change would make
 * the two screens that carry it noisier than the eight that do not, for no
 * information.
 */
export function InfoBanner({ icon, children }: InfoBannerProps) {
  return (
    <div className="avo-info">
      {icon ? (
        <span className="avo-info__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="avo-info__text">{children}</span>
    </div>
  );
}
