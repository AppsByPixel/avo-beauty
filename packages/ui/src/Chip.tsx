import type { ButtonHTMLAttributes } from 'react';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** Whether the chip reads as on. Drives the fill and the dot. */
  on: boolean;
  label: string;
  /**
   * A filled dot beside the label — the permission chips in the design carry
   * one, the audit filter chips do not.
   *
   * The dot is decoration, NOT the state. interaction-spec.md §2: "Status pills
   * must carry their meaning as text, not color alone." The state is announced
   * by the role below, so a dot that fails to render loses nothing.
   */
  dot?: boolean;
  /**
   * `switch` for a permission the click grants or revokes; `radio` for a filter
   * chip where one of a set is current. Both announce their state, which a bare
   * `<button>` with a colour change does not.
   */
  role?: 'switch' | 'radio';
}

/**
 * The pill chip from AVO Merchant Dashboard.dc.html — the nine permission chips
 * on an account card, the Money/Rules/Access/Risk audit filters, and the
 * 15/20/30/45/60 slot-length picker.
 *
 * One component because the design draws them identically: a rounded pill that
 * fills with `--avo-brand-deep` when on. The only difference is what "on" means,
 * which is the `role`.
 */
export function Chip({ on, label, dot = false, role = 'switch', className, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      role={role}
      {...(role === 'switch' ? { 'aria-checked': on } : { 'aria-checked': on })}
      className={['avo-chip', className ?? ''].filter(Boolean).join(' ')}
      data-on={on ? '' : undefined}
      {...rest}
    >
      {dot ? <span className="avo-chip__dot" aria-hidden="true" /> : null}
      {label}
    </button>
  );
}
