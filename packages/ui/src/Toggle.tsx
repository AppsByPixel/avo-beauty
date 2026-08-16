export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** interaction-spec.md §2: toggles are `role="switch"` with `aria-checked`. */
export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
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
      <span className="avo-toggle__label">{label}</span>
    </button>
  );
}
