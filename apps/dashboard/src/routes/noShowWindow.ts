/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NO-SHOW RETURN WINDOW, AS THE MERCHANT READS IT — ONE FUNCTION, TWO SCREENS
 * ═══════════════════════════════════════════════════════════════════════════
 * `noShowReturnMinutes` is stated to the merchant in two places, and they are
 * not two statements of a preference — they are two statements of one rule
 * about a CUSTOMER'S money:
 *
 *   `Settings.tsx` § DepositPanel — "No-show: deposit returns to the wallet
 *   <b>{label}</b> after a missed slot.", beside the control that sets it.
 *
 *   `Appointments.tsx` — "Deposits auto-return to the customer's wallet
 *   <b>{label}</b> after a missed slot …", on the board where she acts on one.
 *
 * WHY THIS IS ITS OWN MODULE. It lived in `Settings.tsx` and was exported from
 * there, which is where it belonged while Settings was the only screen that
 * could say the number. Appointments importing a formatter out of a sibling
 * ROUTE would make the two screens' copy depend on one of them being the other's
 * library; `sectionState.tsx` is the precedent for the shared-but-route-shaped
 * module, and this is the same shape. Both routes now import from here, so
 * neither owns the wording of the other's sentence.
 *
 * THE SINGULAR IS HANDLED, AND SAYING SO PLAINLY IS THE POINT OF THIS PARAGRAPH.
 * `formatReturnWindow(1)` returns "1 minute". The ternaries on both arms are what
 * does it, and both are pinned: `settingsNoShowWindow.test.tsx` § 'says "1
 * minute", not "1 minutes"' and the banner's own `[1, '1 minute']` case in
 * `noShowMarkRender.test.tsx`.
 *
 * The defect the ternaries were written for is HISTORY, not a live gap: the
 * inline expression this function replaced rendered "1 minutes", and 1 is
 * storable — `salon_no_show_return_positive` is `> 0`, so the column admits it
 * and the endpoint accepts it. It never showed on a screen because nothing could
 * reach the field; adding the Settings control is what made it reachable, and the
 * control and the function landed together. Written in the past tense on purpose
 * — a reader should not have to run the function to find out which it is.
 *
 * Above an hour, a non-multiple of 60 stays in minutes — "90 minutes", not "1
 * hour 30 minutes". True, and it invents no copy: the design writes exactly one
 * form of this phrase and the compound is not it. No preset produces it; only a
 * value set elsewhere can.
 */
export function formatReturnWindow(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
