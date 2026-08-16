import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Rendered on the label row, right-aligned — the design's Show/Hide control. */
  action?: ReactNode;
  /** id of an element describing the field, e.g. the sign-in error banner. */
  describedBy?: string | undefined;
}

export function TextField({ label, action, describedBy, className, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <div className="avo-field">
      <div className="avo-field__top">
        <label className="avo-label" htmlFor={id}>
          {label}
        </label>
        {action}
      </div>
      <input
        id={id}
        className={['avo-input', className ?? ''].filter(Boolean).join(' ')}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        {...rest}
      />
    </div>
  );
}
