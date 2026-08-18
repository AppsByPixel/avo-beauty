import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Rendered on the label row, right-aligned — the design's Show/Hide control. */
  action?: ReactNode;
  /** id of an element describing the field, e.g. the sign-in error banner. */
  describedBy?: string | undefined;
  /**
   * Some of the design's inputs carry a placeholder and no visible label — the
   * "New branch name" field in Settings sits inline with its button. The name
   * still has to reach a screen reader, so it moves to `aria-label` rather than
   * disappearing: a placeholder is not a label, and it stops existing the moment
   * she types. Same contract as `Select`.
   */
  labelHidden?: boolean;
}

export function TextField({
  label,
  action,
  describedBy,
  labelHidden = false,
  className,
  ...rest
}: TextFieldProps) {
  const id = useId();
  return (
    <div className="avo-field">
      {labelHidden ? null : (
        <div className="avo-field__top">
          <label className="avo-label" htmlFor={id}>
            {label}
          </label>
          {action}
        </div>
      )}
      <input
        id={id}
        className={['avo-input', className ?? ''].filter(Boolean).join(' ')}
        {...(labelHidden ? { 'aria-label': label } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        {...rest}
      />
    </div>
  );
}
