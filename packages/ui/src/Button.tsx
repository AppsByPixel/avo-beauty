import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  children?: ReactNode;
}

/**
 * Non-negotiable #9 lives here rather than at every call site: the primary fill
 * is `--avo-brand-deep`. Nothing in this library paints white text on
 * `--avo-brand`.
 *
 * REF-FORWARDING, AND IT IS AN ACCESSIBILITY REQUIREMENT RATHER THAN A
 * CONVENIENCE. interaction-spec.md §2 says focus "returns to the trigger on
 * close" for sheets and modals. A trigger a caller cannot hold a reference to
 * cannot be returned to, so a modal would have to either find its opener by DOM
 * selector or leave focus on `<body>` — and `<body>` after closing a dialog puts a
 * keyboard user back at the top of the page, which is the bug the rule exists to
 * prevent. The onboarding wizard is the first caller that needs it.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', block = false, className, type = 'button', ...rest },
  ref,
) {
  const classes = ['avo-btn', `avo-btn--${variant}`, block ? 'avo-btn--block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} type={type} className={classes} {...rest} />;
});
