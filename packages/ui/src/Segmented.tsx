import { useRef, type KeyboardEvent } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A disabled segment still receives focus, so the reason can be announced. */
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the group for a screen reader — "Availability source", "Mechanic". */
  label: string;
}

/**
 * The segmented control the design uses for tiers/stamps, Google/Manual and
 * Team/Customers.
 *
 * interaction-spec.md §2: "Segmented controls (tiers/stamps, period, branch):
 * arrow keys move, Space/Enter selects." That is `role="radiogroup"` semantics,
 * not a row of buttons — a row of buttons is five tab stops and announces
 * nothing about which one is current.
 *
 * ROVING TABINDEX. Only the selected option is tabbable; the arrows move focus
 * *and* selection within the group. This is the WAI-ARIA radio pattern, and it
 * is why Space/Enter has nothing left to do on arrow navigation — the browser
 * has already selected. Enter is still handled because the spec names it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function focusIndex(index: number) {
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const selectable = options.filter((o) => !o.disabled);
    if (selectable.length === 0) return;

    const current = selectable.findIndex((o) => o.value === value);
    let next = current;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (current + 1) % selectable.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + selectable.length) % selectable.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = selectable.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const target = selectable[next];
    if (!target || target.value === value) return;
    onChange(target.value);
    focusIndex(options.findIndex((o) => o.value === target.value));
  }

  return (
    <div
      ref={groupRef}
      className="avo-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the group is one tab stop.
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled ?? false}
            className="avo-segmented__option"
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
