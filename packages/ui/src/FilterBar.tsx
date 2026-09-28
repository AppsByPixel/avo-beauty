import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button.js';
import { EmptyState } from './StateBlocks.js';

/**
 * ===========================================================================
 * THE LIST TOOLBAR — one search field, the filters, a live count, and a way out
 * ===========================================================================
 * Every merchant and console list draws the same row, and the design already
 * drew it once: `AVO Merchant Dashboard.dc.html:329` § audit log — a search
 * input (11px radius, 11×14 padding), then the Money / Rules / Access / Risk
 * pills, then "{n} entries" pushed to the right. This is that row as a
 * component, so a screen asks for a toolbar rather than re-drawing one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide WHERE a filter is applied. Whether a
 * chip narrows a list in the browser or becomes a `?status=` on the request is
 * a fact about the endpoint behind the screen — a list the server pages or caps
 * must not be filtered client-side, because that silently hides the rows the
 * page did not hold. That decision lives with the screen that knows the
 * endpoint; this renders the controls and nothing else.
 *
 * ACCESSIBILITY, in the order interaction-spec.md §2 asks for it:
 *   - the row is a `search` landmark with a name, so a screen-reader user can
 *     jump to "Filter products" rather than tabbing through the page;
 *   - every control is labelled (the search's name is its `label`, never its
 *     placeholder, which stops existing the moment she types);
 *   - chip groups are radio groups with a roving tabindex — one tab stop, arrow
 *     keys move, exactly as `Segmented` does;
 *   - the count is a polite live region, so narrowing a list SAYS how many rows
 *     are left instead of changing a number nobody is looking at. `null` while
 *     pending: "0 products" announced over a skeleton is a claim nobody checked.
 */
export interface FilterBarProps {
  /** Names the landmark — "Filter products", "Filter orders". */
  label: string;
  /**
   * Free text. Omitted on a list where free text finds nothing useful (a
   * status board), rather than drawn and ignored.
   */
  search?: {
    value: string;
    onChange: (next: string) => void;
    /** The accessible name. Required; a placeholder is not a label. */
    label: string;
    placeholder: string;
  };
  /**
   * The result line, already phrased — "12 products", "3 of 40 shown". `null`
   * while the list is pending, and the region stays mounted empty so the first
   * real count is announced rather than missed.
   */
  count: string | null;
  /** Present only while at least one filter is narrowing the list. */
  onClear?: (() => void) | undefined;
  /** The filter controls: `FilterChips`, `FilterSelect`, or a screen's own. */
  children?: ReactNode;
  className?: string;
}

export function FilterBar({ label, search, count, onClear, children, className }: FilterBarProps) {
  return (
    <div
      role="search"
      aria-label={label}
      className={['avo-filterbar', className ?? ''].filter(Boolean).join(' ')}
    >
      {search ? (
        <input
          className="avo-input avo-filterbar__search"
          type="search"
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          placeholder={search.placeholder}
          aria-label={search.label}
        />
      ) : null}
      {children}
      <span className="avo-filterbar__count" role="status" aria-live="polite">
        {count ?? ''}
      </span>
      {onClear ? (
        <Button variant="quiet" className="avo-filterbar__clear" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  /** Names the group — "Status", "Kind". */
  label: string;
  options: ReadonlyArray<FilterChipOption<T>>;
  value: T;
  onChange: (next: T) => void;
}

/**
 * The audit log's pill row, as a radio group: one of the set is current, the
 * group is one tab stop, and the arrows move focus AND selection — the WAI-ARIA
 * radio pattern `Segmented` already implements, in the outlined chip the design
 * draws for filters (`.avo-chip--outline`, "the audit filter row sits on the
 * canvas, not on a card").
 */
export function FilterChips<T extends string>({ label, options, value, onChange }: FilterChipsProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = options.findIndex((o) => o.value === value);
    let next = current;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (current + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + options.length) % options.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = options[next];
    if (!target) return;
    if (target.value !== value) onChange(target.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="avo-filterbar__chips"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="avo-chip avo-chip--outline"
            data-on={on ? '' : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface FilterSelectProps<T extends string> {
  /** The accessible name — "Branch", "Role". The first option carries the visible "All …". */
  label: string;
  options: ReadonlyArray<FilterChipOption<T>>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}

/**
 * A native `<select>` for a set too long to be pills — branches, roles, staff.
 * Native for `Select`'s reasons (type-ahead, the platform picker, correct
 * announcement). The label is `aria-label` because a toolbar row has no room for
 * a stacked one; the selected option's own text ("All branches") is what a
 * sighted reader sees.
 */
export function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: FilterSelectProps<T>) {
  return (
    <select
      className="avo-select avo-select--sm avo-filterbar__select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * THE FILTERED EMPTY — a different fact from "nothing here yet", and never the
 * same copy. `AVO States.dc.html` § "Search · no results": echo what was asked
 * and offer the escape, distinct from "no data at all". A list that says "No
 * products yet" under an active filter tells a merchant her catalog is empty.
 *
 * `things` is the plural noun the screen already uses — "products", "orders".
 */
export function FilterEmpty({ things, onClear }: { things: string; onClear: () => void }) {
  return (
    <EmptyState
      title={`No ${things} match these filters`}
      body="Try a different search, or clear the filters to see everything again."
      action={{ label: 'Clear filters', onClick: onClear }}
    />
  );
}
