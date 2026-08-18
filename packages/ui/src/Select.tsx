import { useId, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * `size` is dropped from the native attributes on purpose: on a `<select>` it
 * means "rows visible at once", which turns the control into a list box and is
 * not a thing this design has. The name is reused here for the density variant,
 * which is what a caller in this codebase means by it.
 */
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'size'> {
  /** Always required. When `labelHidden`, it becomes the accessible name only. */
  label: string;
  options: ReadonlyArray<SelectOption>;
  /**
   * The design's compact in-row selects (role, branch access on a team card)
   * carry no visible label — the column is self-evident and a stacked label
   * would break the row. The name still has to reach a screen reader, so it
   * moves to `aria-label` rather than disappearing.
   */
  labelHidden?: boolean;
  size?: 'md' | 'sm';
}

/**
 * A native `<select>`, deliberately.
 *
 * The design draws one and a custom listbox would be a worse control here: the
 * native element already gives keyboard type-ahead, the platform's touch
 * picker, and correct announcement, and interaction-spec.md §2 asks for none of
 * the behaviours a custom widget would be needed to add. The focus ring comes
 * from the `:focus-visible` rule in @avo/tokens, so this carries no outline of
 * its own.
 */
export function Select({
  label,
  options,
  labelHidden = false,
  size = 'md',
  className,
  ...rest
}: SelectProps) {
  const id = useId();
  const classes = ['avo-select', `avo-select--${size}`, className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={labelHidden ? 'avo-select-wrap' : 'avo-field'}>
      {labelHidden ? null : (
        <label className="avo-label" htmlFor={id}>
          {label}
        </label>
      )}
      <select
        id={id}
        className={classes}
        {...(labelHidden ? { 'aria-label': label } : {})}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled ?? false}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
