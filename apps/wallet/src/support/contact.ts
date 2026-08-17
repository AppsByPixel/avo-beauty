/**
 * The seam between a receipt and the contact form.
 *
 * "Report a problem with this payment" on a receipt hands over that receipt's
 * reference; Account reads it once on mount and opens Contact us with the
 * reference already in the field. Two modules, one value, and no prop threaded
 * through four components that do not care about it.
 *
 * Two things are deliberately NOT decided here, because they are not the
 * client's to decide:
 *
 *   · **The route.** Non-negotiable #11: support ticket routing is resolved
 *     server-side from `topicId`. A client that picks "salon" or "AVO" can land
 *     a wallet dispute in a salon's inbox. Nothing in this module sets a route,
 *     and the form does not either — it posts a topic and the server decides.
 *     See src/api/account.ts § TicketDraft.
 *   · **The topic.** A payment problem is not automatically a wallet dispute;
 *     the customer chooses from the published topic list in
 *     GET /v1/platform/support. So the handoff carries the reference and nothing
 *     else, and the topic picker opens unselected.
 *
 * WHY A MODULE-LEVEL VALUE RATHER THAN A CONTEXT OR A ROUTE PARAM: it is
 * write-once, read-once, and it must survive a screen change. A context would
 * have to be provided above both screens for a value neither of them owns, and
 * there is no router in this app yet to carry a param. When one lands, this
 * becomes a navigation param and `takeContactPrefill` disappears — the two
 * call sites are the only things that change.
 */

export interface ContactPrefill {
  /** The gateway or AVO reference from the receipt the customer was looking at. */
  reference: string;
}

let pending: ContactPrefill | null = null;

/** Called by the receipt sheet, immediately before navigating to Account. */
export function startPaymentReport(reference: string): ContactPrefill {
  pending = { reference };
  return pending;
}

/**
 * Read and clear. Account calls this once, on mount.
 *
 * Clearing on read is what stops a stale receipt number appearing in the form
 * three visits later: opening Account from the avatar finds nothing pending, so
 * the reference field is empty, which is what it should be.
 */
export function takeContactPrefill(): ContactPrefill | null {
  const value = pending;
  pending = null;
  return value;
}
