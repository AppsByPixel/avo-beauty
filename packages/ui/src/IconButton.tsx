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
  /**
   * NO HAIRLINE UNTIL IT IS POINTED AT. For a control that repeats on every card
   * of a grid — the Overview's per-card Export — where thirteen bordered pills
   * would be the loudest thing on the screen. Same icon, same 12px label, same
   * colour; the border and background arrive on hover and focus. Shorter, too
   * (24px), so it sits inside a card title's line box without growing the head.
   */
  quiet?: boolean;
}

/**
 * A small bordered control: icon + short label. Aftab, 2026-09-29: "The change
 * status buttons on the appointment lists should be more visible like icons".
 *
 * REF-FORWARDING for `Button`'s reason: a trigger a caller cannot hold is a
 * trigger focus cannot be returned to.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tone = 'neutral', quiet = false, className, type = 'button', ...rest },
  ref,
) {
  const classes = ['avo-iconbtn', `avo-iconbtn--${tone}`, quiet ? 'avo-iconbtn--quiet' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      <span className="avo-iconbtn__icon">{icon}</span>
      <span className="avo-iconbtn__label">{label}</span>
    </button>
  );
});
