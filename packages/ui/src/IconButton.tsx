import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonTone = 'neutral' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** An icon from `icons.tsx`. Decorative; the name is `label` or `aria-label`. */
  icon: ReactNode;
  /**
   * THE VISIBLE SHORT LABEL, ALWAYS DRAWN. An icon alone is a guess about what a
   * glyph means, and on a board where two of these release a customer's slot the
   * guess is not cheap. So the word stays beside the icon; the icon is what makes
   * the control findable at a glance.
   */
  label: string;
  /**
   * `danger` for the two that cannot be undone and release the slot — cancel and
   * no-show. Danger TEXT token, not the danger dot: the dot is about 3.0:1 and
   * this is text.
   */
  tone?: IconButtonTone;
}

/**
 * A small bordered control: icon + short label. Aftab, 2026-09-29: "The change
 * status buttons on the appointment lists should be more visible like icons".
 *
 * REF-FORWARDING for `Button`'s reason: a trigger a caller cannot hold is a
 * trigger focus cannot be returned to.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tone = 'neutral', className, type = 'button', ...rest },
  ref,
) {
  const classes = ['avo-iconbtn', `avo-iconbtn--${tone}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      <span className="avo-iconbtn__icon">{icon}</span>
      <span className="avo-iconbtn__label">{label}</span>
    </button>
  );
});
