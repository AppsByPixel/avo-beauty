/**
 * The seam between a receipt and the contact form.
 *
 * The contact form itself is a later slice — design/AVO Wallet Home.dc.html's
 * `contactOpen` sheet, with its topic list, message field and "Receipt or
 * reference" input. What is built here is the *entry point*: "Report a problem
 * with this payment" hands over the receipt's reference, and the form picks it up
 * pre-filled.
 *
 * Two things are deliberately NOT decided here, because they are not the
 * client's to decide:
 *
 *   · **The route.** Non-negotiable #11: support ticket routing is resolved
 *     server-side from `topicId`. A client that picks "salon" or "AVO" can land
 *     a wallet dispute in a salon's inbox. Nothing in this module sets a route,
 *     and the form must not either — it posts a topic and the server decides.
 *   · **The topic.** A payment problem is not automatically a wallet dispute; the
 *     customer chooses from the published topic list in GET /v1/platform/support.
 *
 * So the handoff carries one field, and that field is the reference.
 */

export interface ContactPrefill {
  /** The gateway or AVO reference from the receipt the customer was looking at. */
  reference: string;
}

let pending: ContactPrefill | null = null;

/**
 * Called by the receipt sheet. Records what the form should open with.
 *
 * STUB: when the contact form lands, this is where it is opened from — replace
 * the store with a navigation call and keep the prefill. Nothing else in the app
 * needs to change.
 */
export function startPaymentReport(reference: string): ContactPrefill {
  pending = { reference };
  if (__DEV__) {
    // Evidence that the entry point carries the right receipt while the target
    // does not exist yet. Stripped from a release bundle.
    console.log('[avo] contact form handoff (not built yet) · reference:', reference);
  }
  return pending;
}

/** Read and clear. The form will call this on mount. */
export function takeContactPrefill(): ContactPrefill | null {
  const value = pending;
  pending = null;
  return value;
}
