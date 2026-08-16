/**
 * interaction-spec.md §1, the "below 768" row.
 *
 * This is the design, not a gap. Merchants manage on desktop by design; the
 * phone surface is the staff scanner, which is a different app entirely.
 */
export function UnsupportedWidth() {
  return (
    <div className="dash-toosmall">
      <div className="dash-toosmall__card">
        <span className="dash-toosmall__mark" aria-hidden="true">
          A
        </span>
        <h1 className="dash-toosmall__title avo-display">
          Open the dashboard on a larger screen
        </h1>
        <p className="dash-toosmall__body">
          The merchant workspace needs at least 768px of width — a laptop or a tablet in
          landscape. On a phone, use the AVO Scanner app to charge customers and check today&rsquo;s
          bookings.
        </p>
      </div>
    </div>
  );
}
