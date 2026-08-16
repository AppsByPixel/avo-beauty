import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
 */
export function Button({
  variant = 'primary',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['avo-btn', `avo-btn--${variant}`, block ? 'avo-btn--block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}
