export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /**
   * The design's settings rows put the name and its description to the LEFT of a
   * bare switch — `AVO Owner Console.dc.html` § CONTROLS and the merchant module
   * rows both. Rendering the label beside the knob as well printed it twice, which
   * driving the console's Controls screen showed immediately.
   *
   * So the label becomes the accessible name only, the same affordance `Select`
   * offers for its compact in-row variant. It stays in the DOM under `.avo-sr-only`
   * rather than moving to `aria-label`, so the switch keeps a real accessible name
   * computed from its contents and a translated label cannot drift from the visible
   * row it belongs to.
   *
   * Default `false` — every existing call site draws the label and keeps doing so.
   */
  labelHidden?: boolean;
  disabled?: boolean;
}

/** interaction-spec.md §2: toggles are `role="switch"` with `aria-checked`. */
export function Toggle({
  checked,
  onChange,
  label,
  labelHidden = false,
  disabled = false,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="avo-toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="avo-toggle__track">
        <span className="avo-toggle__knob" />
      </span>
      <span className={labelHidden ? 'avo-sr-only' : 'avo-toggle__label'}>{label}</span>
    </button>
  );
}
