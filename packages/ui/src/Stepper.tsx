import type { KeyboardEvent, ReactNode } from 'react';

export interface StepperProps {
  /** The current value, in whatever unit `step` and `format` agree on. */
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  /** Rendered in the middle slot. Money must arrive here already formatted. */
  format: (value: number) => ReactNode;
  /** Announced as the control's name, and used to build the button labels. */
  label: string;
  /** Spoken form of the current value, when `format` renders a glyph. */
  valueText?: string;
  disabled?: boolean;
  size?: 'md' | 'sm';
}

/**
 * The −/+ stepper: the booking deposit, and every From/To time in the team
 * hours editor.
 *
 * interaction-spec.md §2: "Steppers (deposit, From/To hours): Up/Down adjust by
 * one step, Page Up/Down by four." Both are implemented here rather than at the
 * three call sites, because a keyboard affordance that exists on the deposit and
 * not on Saturday's closing time is worse than one that exists nowhere — it
 * teaches a merchant a key that then silently does nothing.
 *
 * `role="spinbutton"` with `aria-valuenow/min/max` is what makes the arrow keys
 * expected rather than surprising: a screen reader announces the control as
 * adjustable before the user tries.
 *
 * CLAMPED, NOT WRAPPED. A deposit at 10 KD with `+` pressed stays at 10. Wrapping
 * to 1 would be a 9 KD change from one keypress on a money field.
 */
export function Stepper({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label,
  valueText,
  disabled = false,
  size = 'md',
}: StepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  function nudge(delta: number) {
    const next = clamp(value + delta);
    if (next !== value) onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        nudge(step);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        nudge(-step);
        break;
      case 'PageUp':
        nudge(step * 4);
        break;
      case 'PageDown':
        nudge(-step * 4);
        break;
      case 'Home':
        if (value !== min) onChange(min);
        break;
      case 'End':
        if (value !== max) onChange(max);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      className={`avo-stepper avo-stepper--${size}`}
      role="spinbutton"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      {...(valueText ? { 'aria-valuetext': valueText } : {})}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="avo-stepper__btn"
        aria-label={`Decrease ${label}`}
        // The whole control is one tab stop; the buttons are mouse affordances.
        tabIndex={-1}
        disabled={disabled || value <= min}
        onClick={() => nudge(-step)}
      >
        &minus;
      </button>
      <span className="avo-stepper__value" aria-hidden="true">
        {format(value)}
      </span>
      <button
        type="button"
        className="avo-stepper__btn"
        aria-label={`Increase ${label}`}
        tabIndex={-1}
        disabled={disabled || value >= max}
        onClick={() => nudge(step)}
      >
        +
      </button>
    </div>
  );
}
