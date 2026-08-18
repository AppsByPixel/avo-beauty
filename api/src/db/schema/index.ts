/**
 * The AVO schema, in dependency order.
 *
 *   platform_admin ──── session   the owner console's principal, and the one
 *                                 credential with NO salon: it reads across all
 *                                 of them by design
 *   platform_messaging_policy     one row, platform-wide — approval, caps, quiet
 *                                 hours. A merchant can never read or raise it.
 *
 *   salon ─┬─ branch ─┬─ boost
 *          │          └─ happy_hour (branch_id NULL = every branch)
 *          ├─ service
 *          ├─ product
 *          ├─ artist (→ staff_user, optionally: an artist needs no login)
 *          ├─ member ──── wallet_token
 *          ├─ staff_user
 *          ├─ session ──── pin_attempt
 *          ├─ booking ──── artist_calendar_connection (per artist)
 *          ├─ merchant_notification
 *          ├─ campaign ──── campaign_send (→ member)
 *          └─ transaction ─┬─ ledger_entry
 *                          ├─ idempotency_key
 *                          ├─ receipt_job
 *                          ├─ shop_order_line (→ product)
 *                          └─ topup_intent ──── gateway_event
 *          audit_log (soft references only — see audit.ts)
 *          sandbox_gateway_payment (the sandbox PSP's own store — not product)
 *
 * THE COUNT THAT USED TO OPEN THIS COMMENT SAID "Nineteen tables". There were
 * thirty-one, and the tree below it was missing twelve — the legal set, the
 * support trio, notification preferences, the consent event log, the signup
 * counter, the phone-change challenge and the password-reset table among them.
 * A number in a header is a claim that goes stale on the next migration and is
 * never the reason anyone opens the file, so it is gone rather than corrected;
 * the tree names the relationships, which is the part that is worth reading and
 * the part `drizzle-kit` cannot infer for you.
 *
 * Drizzle needs every table reachable from one module for `drizzle-kit generate`
 * and for the migrator; this is that module.
 */

export * from './_shared';
export * from './salon';
export * from './promotion';
export * from './service';
export * from './product';
export * from './artist';
export * from './member';
export * from './phoneChange';
export * from './staff';
export * from './session';
export * from './transaction';
export * from './ledger';
export * from './shopOrder';
export * from './audit';
export * from './loyaltyEvent';
export * from './idempotency';
export * from './walletToken';
export * from './receipt';
export * from './topup';
export * from './booking';
export * from './notification';
export * from './legal';
export * from './platformAdmin';
export * from './campaign';
export * from './sandboxGateway';
