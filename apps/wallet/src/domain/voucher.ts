/**
 * What a failed redemption means, and what the sheet is allowed to say about it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SERVER DOES NOT DISTINGUISH EXPIRED FROM VOIDED FROM ALREADY-REDEEMED.
 * THIS IS THE CENTRAL FACT OF THE SCREEN AND IT IS A DELIBERATE DECISION.
 * ═════════════════════════════════════════════════════════════════════════════
 * `api/src/routes/vouchers.ts`, in its own header: "Expired, never existed,
 * already redeemed, voided, or issued to somebody else all answer
 * `voucher_not_redeemable` with one message." It names the tension it is
 * resolving — the states must be distinguishable to HER and indistinguishable to
 * an ATTACKER enumerating codes — and resolves it toward the attacker, because
 * her recovery path is identical in every case: she contacts support, who CAN
 * tell them apart from the row.
 *
 * Driven against avo_lane_b on port 4710, five codes, one answer:
 *
 *   expired          HTTP 409  voucher_not_redeemable
 *   voided           HTTP 409  voucher_not_redeemable
 *   already redeemed HTTP 409  voucher_not_redeemable
 *   never existed    HTTP 409  voucher_not_redeemable
 *   someone else's   HTTP 409  voucher_not_redeemable   (route-scoped by memberId)
 *
 * So there is ONE refusal string and there cannot be three. A client that wrote
 * "this voucher has expired" would be inventing a fact the server withheld on
 * purpose, and it would be wrong four times in five.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A REFUSAL ARRIVES CLASSIFIED AS `'server'`, AND THAT IS THE TRAP HERE.
 * ═════════════════════════════════════════════════════════════════════════════
 * `client.ts § classify` maps 401/403 to `'forbidden'`, 503/504 to `'offline'`
 * and EVERYTHING ELSE to `'server'` — "our fault, so the screen offers Try
 * again". A 409 is everything else. Keying the sheet off `err.kind` would
 * therefore offer Try again on a dead code, forever, which is the one thing
 * interaction-spec.md §4 says a "you can't" must never do.
 *
 * So the CODE decides, not the kind. This is the same reason `ApiError.code`
 * exists at all — its own comment: "The three kinds are not enough for booking",
 * and they are not enough here either.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE REFUSAL IS OUR STRING, NOT THE SERVER'S, AND THAT IS NON-NEGOTIABLE #12.
 * ═════════════════════════════════════════════════════════════════════════════
 * `ChangePasswordSheet` renders `err.message` and is right to: that message
 * distinguishes a wrong password from an outage, which is information the client
 * does not otherwise have. Here the message carries no information the code does
 * not — one code, one message, forever — and the API emits English only. Showing
 * it would put an English sentence in the middle of an Arabic sheet on the one
 * screen whose entire purpose is an apology. The English wording below is the
 * server's, character for character, so the two cannot disagree; the Arabic is a
 * gap, listed, not invented.
 */

import { ApiError } from '../api/client';
import type { Copy } from '../copy/types';

/**
 * Why a redemption did not happen.
 *
 * `refused` is the only one of these that is ABOUT THE CODE. The other three are
 * about the request, and only they may offer a retry — see `canRetryRedeem`.
 */
export type RedeemFailure =
  /** 409 `voucher_not_redeemable`. Expired, voided, spent, unknown, or not hers. */
  | 'refused'
  /**
   * 400. `code_only` (a body field the server refuses by name), `invalid_code`
   * (empty) or a `requireString` length refusal. Unreachable from this app —
   * the sheet sends one field and caps the length — so it is a defect in US, and
   * the copy says so rather than blaming her code.
   */
  | 'rejected'
  /** No connection, or our own 15s abort. Nothing was spent. */
  | 'offline'
  /** 5xx, a contract-parse failure, or a 401/403 that outlived the refresh. */
  | 'failed';

/**
 * ONE PLACE WHERE THE CODE `voucher_not_redeemable` IS SPELLED.
 *
 * Duplicated across the sheet and a test it becomes two places, and the day the
 * API renames it only one of them fails.
 */
export const NOT_REDEEMABLE = 'voucher_not_redeemable';

export function classifyRedeemFailure(err: unknown): RedeemFailure {
  if (!(err instanceof ApiError)) return 'failed';
  if (err.code === NOT_REDEEMABLE) return 'refused';
  /*
    `code_only` and `invalid_code` are the route's own 400s. A 400 is classified
    `'server'` like everything else, so again the code decides. Grouped rather
    than split because all three mean the same thing to her — this app sent
    something the server would not take — and she can do nothing about any of
    them.
  */
  if (err.status === 400) return 'rejected';
  if (err.kind === 'offline') return 'offline';
  return 'failed';
}

/**
 * Whether the sheet offers Try again.
 *
 * FALSE ON A REFUSAL, AND THAT IS THE WHOLE RULE. interaction-spec.md §4
 * separates "we failed (retry)" from "you can't (explain, no retry)", and a dead
 * code is the second no matter how many times it is sent. FALSE ON `rejected`
 * too: the body did not change between attempts, so neither will the answer.
 */
export function canRetryRedeem(failure: RedeemFailure): boolean {
  return failure === 'offline' || failure === 'failed';
}

export function redeemFailureMessage(failure: RedeemFailure, copy: Copy): string {
  switch (failure) {
    case 'refused':
      return copy.vchRefused;
    case 'rejected':
      return copy.vchRejected;
    case 'offline':
      return copy.vchOffline;
    case 'failed':
      return copy.vchFailed;
  }
}

/**
 * Whether the Redeem button is live.
 *
 * TRIM, BECAUSE WHITESPACE IS NOT A CODE. The server would answer `invalid_code`
 * on `"   "` — `normaliseCode` strips spaces, leaving the empty string, and
 * `requireString` refuses it — so a live button here would spend a round trip to
 * learn what the field already knows. It is a courtesy and not a rule: the server
 * still decides, and this is only about not asking it a question with no content.
 *
 * NOTHING ELSE IS VALIDATED. Length, alphabet and checksum all belong to the
 * server's own `normaliseCode`/`mintCode` pair, and a client that rejected a
 * lowercase code, or one with a dash in it, would refuse input the server
 * accepts — driven: `"vmq5-cxmc-ggk3"` redeemed successfully.
 */
export function canSubmitCode(raw: string): boolean {
  return raw.trim().length > 0;
}

/**
 * The longest code the field accepts.
 *
 * `requireString(body.code, 'code', 64)` is the server's cap, so 64 is the point
 * past which typing can only produce a 400. Codes are minted at 12 characters;
 * the slack is for a code read aloud and typed with dashes and spaces, which
 * `normaliseCode` removes.
 */
export const CODE_MAX_LENGTH = 64;
