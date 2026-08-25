/**
 * The top-up state machine.
 *
 * Five stages the customer can see — choose, redirect, result, the failure of the
 * quote itself, and the payment page failing to open — expressed as a
 * discriminated union so that "which screen am I on" and "what data does that
 * screen have" cannot drift apart. A `result` stage without an intent does not
 * type-check, which is the point: every one of the four outcome screens is
 * rendered from a real server response.
 *
 * The fifth was added because the app had no way to say "the payment page would
 * not open". It said "we couldn't start that top-up" — the words for a request
 * that never reached the server — or it said nothing at all and sat on the
 * undismissible redirect screen forever. Both are the same failure of the state
 * machine: a real outcome with no stage to land on.
 *
 * The rules from api-contract.md § TopUpIntent are enforced here rather than in
 * the components:
 *
 *   1. The return URL is a hint. `settle()` never reads a status out of a
 *      redirect; it waits for the customer to come back and then re-reads
 *      GET /topups/{id}, and it keeps re-reading until that endpoint says
 *      something terminal.
 *   2. `pending` is its own outcome. It is never mapped onto success or failure,
 *      and `canRetry()` is false for it.
 *   3. One idempotency key per attempt, reused across retries of that attempt.
 *   4. No balance is computed here. On success the caller is told to re-read the
 *      member; `creditFils` is never added to anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fils, type Fils, type PaymentMethod, type TopUpIntentPublic } from '@avo/types';
import { ApiError, newIdempotencyKey, type FailureKind } from '../api/client';
import { createTopUp, getTopUp } from '../api/topups';
import { openGateway } from '../platform/gateway';
import { gatewayOpenLog, type GatewayOpenFailure } from '../domain/gateway';
import {
  DEFAULT_PAYMENT_METHOD,
  isTerminal,
  outcomeOf,
  type TopUpOutcome,
} from '../domain/topup';

export interface QuoteFailure {
  kind: FailureKind;
  message: string;
  reference: string;
}

export type TopUpStage =
  /** The sheet is not open. */
  | { name: 'closed' }
  /** Asking the server what this amount is worth. No intent yet, so no numbers. */
  | { name: 'quoting'; amountFils: Fils; method: PaymentMethod }
  /** The quote itself failed. Nothing was charged — there is not even an intent. */
  | { name: 'quoteFailed'; amountFils: Fils; method: PaymentMethod; failure: QuoteFailure }
  /** A real intent. Its bonus and credit are what the calculation card renders. */
  | { name: 'ready'; intent: TopUpIntentPublic }
  /** At the bank. NOT DISMISSIBLE — see interaction-spec.md §2. */
  | { name: 'redirect'; intent: TopUpIntentPublic }
  /**
   * The payment page would not open. An intent EXISTS and nothing was charged.
   *
   * Its own stage, and not folded into `quoteFailed` or into the `declined`
   * outcome, because those three are different problems with different next
   * actions: `quoteFailed` has no intent behind it and retries the POST,
   * `declined` means a bank looked at the payment and said no, and this one means
   * she never saw a payment page — the same top-up is still waiting and the right
   * action is to open it again.
   */
  | { name: 'gatewayFailed'; intent: TopUpIntentPublic; failure: GatewayOpenFailure }
  /** One of exactly four outcomes, from GET /topups/{id} and nowhere else. */
  | { name: 'result'; intent: TopUpIntentPublic; outcome: TopUpOutcome };

/**
 * The one place a stage is allowed to say whether it can be dismissed.
 *
 * interaction-spec.md §2: "`Esc` closes — **except** the KNET redirect state,
 * which is deliberately not dismissible." The customer is at her bank. Closing
 * the sheet would strand a live payment behind a screen that no longer exists,
 * and she would reasonably start another one.
 *
 * `gatewayFailed` IS dismissible, and that is the whole reason it exists as a
 * stage. Before it, a failed open left the sheet parked on `redirect` — the one
 * screen with no close control, no Esc, no back — forever, over a bank page that
 * had never appeared. A non-dismissible screen is only defensible while there is
 * genuinely a payment in flight to protect.
 */
export function isDismissible(stage: TopUpStage): boolean {
  return stage.name !== 'redirect';
}

/** How long before the first status read. Long enough that she has arrived. */
const FIRST_POLL_MS = 1500;
/** And between reads after that. */
const POLL_MS = 2000;
/**
 * Consecutive failed reads before we stop and say so. Six reads over roughly
 * twelve seconds; past that the honest answer is "we do not know yet", which is
 * the pending screen — and the pending screen offers no retry, which is exactly
 * right for a payment we have lost sight of.
 */
const MAX_READ_FAILURES = 6;
/**
 * Non-terminal reads AFTER a confirmed return before we stop and say "pending".
 * Thirty reads at `POLL_MS` is a minute, which is the minute `pendingMsg`
 * promises: "This can take up to a minute."
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS BOUND IS NEW AND IT CLOSES THE SAME HOLE AS `gatewayFailed`.
 *
 * The loop had no way out that did not involve a terminal status or a broken
 * endpoint. A customer who opened the bank page and closed it without paying
 * left the intent at `redirected` forever, every read succeeded, `failures`
 * stayed at zero — and the sheet sat on the ONE screen with no close control,
 * no Esc and no back, for as long as the app was alive.
 *
 * IT ONLY ARMS AFTER `session.returned` FIRES, and that is the safety. While she
 * may still be at the bank we wait indefinitely, exactly as before; the clock
 * starts only once something told us she is back, at which point a server that
 * still says `redirected` genuinely means "we do not know yet". `pending` is the
 * screen for that, and `canRetry('pending')` is false — so the way out cannot
 * turn into a second payment.
 *
 * The bound is worth having BECAUSE of `openAuthSessionAsync`: the old
 * `AppState`-plus-deep-link guess was too weak to hang a timeout on, and the
 * browser session resolving with a result is not.
 * ═════════════════════════════════════════════════════════════════════════════
 */
const MAX_READS_AFTER_RETURN = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFailure(err: unknown): QuoteFailure {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError('server', 'Something went wrong.', 'WLT-0000-0000', null);
  return { kind: apiError.kind, message: apiError.message, reference: apiError.reference };
}

export interface TopUpController {
  stage: TopUpStage;
  /** Open the sheet for an amount and quote it. */
  open: (amountFils: Fils) => void;
  /** Re-quote against a different rail. A different body, so a different key. */
  chooseMethod: (method: PaymentMethod) => void;
  /** Retry a quote that failed, reusing the key — it may already exist server-side. */
  retryQuote: () => void;
  /** Hand off to the gateway. */
  pay: () => void;
  /**
   * Open the payment page again for an intent whose page never appeared.
   *
   * The SAME intent, deliberately. Nothing was charged and nothing was consumed,
   * so there is nothing to re-create — and re-quoting here would leave the first
   * intent orphaned for every tap.
   */
  retryOpen: () => void;
  /** A fresh attempt after a decline or a cancel. Never offered from pending. */
  tryAgain: (method?: PaymentMethod) => void;
  /** Close. Refuses while the redirect stage is up. */
  close: () => void;
}

export function useTopUp(options: { onSucceeded: () => void }): TopUpController {
  const [stage, setStage] = useState<TopUpStage>({ name: 'closed' });

  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  /**
   * The current attempt's idempotency key. Held in a ref rather than in the
   * stage because it must survive a retry of a *failed* request unchanged — that
   * is the whole reason the key exists (non-negotiable #4). It is cleared when
   * the attempt ends, so the next attempt mints a new one.
   */
  const attemptKey = useRef<string | null>(null);
  /** Bumped on every new attempt so a late response from an old one is ignored. */
  const attemptId = useRef(0);
  const onSucceeded = useRef(options.onSucceeded);
  onSucceeded.current = options.onSucceeded;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  const quote = useCallback(
    async (amountFils: Fils, method: PaymentMethod, reuseKey: boolean) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const attempt = (attemptId.current += 1);

      if (!reuseKey || attemptKey.current === null) {
        attemptKey.current = newIdempotencyKey();
      }
      const idempotencyKey = attemptKey.current;

      setStage({ name: 'quoting', amountFils, method });

      try {
        const intent = await createTopUp(
          { amountFils, method, idempotencyKey },
          controller.signal,
        );
        if (!mounted.current || attempt !== attemptId.current) return;
        setStage({ name: 'ready', intent });
      } catch (err) {
        if (!mounted.current || attempt !== attemptId.current) return;
        if (controller.signal.aborted) return;
        setStage({ name: 'quoteFailed', amountFils, method, failure: toFailure(err) });
      }
    },
    [],
  );

  /**
   * The redirect stage, from handing off to knowing.
   *
   * Note what is NOT here: any reading of the return URL. `session.returned`
   * only shortens the wait before the next authoritative read. If it never
   * fires — the customer left the tab open, the deep link was swallowed by the
   * OS — the poll still resolves the payment, which is why the hint can safely
   * be treated as worthless.
   *
   * WHAT *IS* NOW HERE IS THE OPEN ITSELF FAILING. `openGateway` used to be
   * fire-and-forget with a swallowed rejection, so this function walked straight
   * into the poll loop over a page nobody had seen and parked the sheet on its
   * non-dismissible screen. The handoff is awaited and its failure is a stage.
   */
  const settle = useCallback(async (intent: TopUpIntentPublic) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const attempt = (attemptId.current += 1);

    setStage({ name: 'redirect', intent });

    const handoff = await openGateway(intent.redirectUrl);
    if (!mounted.current || attempt !== attemptId.current || controller.signal.aborted) return;

    if (!handoff.opened) {
      /*
        NOT SWALLOWED, IN THREE PLACES AT ONCE: a console line a developer can
        act on, a stage the customer can act on, and the attempt key left ALONE.

        Leaving the key is the money-safe half. The intent is real and unpaid;
        retrying the open reuses it rather than minting a second one, so a
        customer tapping the button four times over a phone that will not open a
        browser does not leave four `TI-…` rows and cannot end up paying twice.
      */
      // eslint-disable-next-line no-console
      console.warn(gatewayOpenLog(intent.id, handoff));
      setStage({
        name: 'gatewayFailed',
        intent,
        failure: { reason: handoff.reason, detail: handoff.detail },
      });
      return;
    }

    const session = handoff.session;
    let hinted = false;
    let delay = FIRST_POLL_MS;
    let failures = 0;
    let readsAfterReturn = 0;

    try {
      for (;;) {
        if (hinted) {
          await sleep(delay);
        } else {
          await Promise.race([
            sleep(delay),
            session.returned.then(() => {
              hinted = true;
            }),
          ]);
        }
        if (!mounted.current || attempt !== attemptId.current || controller.signal.aborted) {
          return;
        }

        try {
          const fresh = await getTopUp(intent.id, controller.signal);
          if (!mounted.current || attempt !== attemptId.current) return;
          failures = 0;
          if (isTerminal(fresh.status)) {
            const outcome = outcomeOf(fresh.status);
            attemptKey.current = null; // this attempt is over, whatever happened
            setStage({ name: 'result', intent: fresh, outcome });
            // Non-negotiable #2: the balance is re-read from the server, never
            // adjusted here by creditFils.
            if (outcome === 'success') onSucceeded.current();
            return;
          }
          if (hinted) {
            readsAfterReturn += 1;
            if (readsAfterReturn >= MAX_READS_AFTER_RETURN) {
              // She is back, the endpoint is answering, and it still says the
              // payment has not resolved. That is "we do not know", not "it
              // failed" — and it is not a reason to keep her on a screen she
              // cannot leave.
              attemptKey.current = null;
              setStage({ name: 'result', intent: fresh, outcome: 'pending' });
              return;
            }
          }
        } catch (err) {
          if (!mounted.current || attempt !== attemptId.current) return;
          if (controller.signal.aborted) return;
          failures += 1;
          if (failures >= MAX_READ_FAILURES) {
            // We cannot reach the endpoint that owns the answer. That is not a
            // failure of the payment and must not be presented as one — she may
            // well have paid. "We do not know yet" is the pending screen, and
            // the pending screen offers no retry.
            attemptKey.current = null;
            setStage({ name: 'result', intent, outcome: 'pending' });
            return;
          }
          void err;
        }
        delay = POLL_MS;
      }
    } finally {
      session.dispose();
    }
  }, []);

  const open = useCallback(
    (amountFils: Fils) => {
      attemptKey.current = null;
      void quote(amountFils, DEFAULT_PAYMENT_METHOD, false);
    },
    [quote],
  );

  const chooseMethod = useCallback(
    (method: PaymentMethod) => {
      setStage((current) => {
        const amountFils =
          current.name === 'ready'
            ? fils(current.intent.amountFils)
            : current.name === 'quoting' || current.name === 'quoteFailed'
              ? current.amountFils
              : null;
        if (amountFils === null) return current;
        // A different body under the same key is a 422 by api-contract.md's
        // addendum, and rightly so. A new rail is a new attempt, so a new key.
        attemptKey.current = null;
        void quote(amountFils, method, false);
        return current;
      });
    },
    [quote],
  );

  const retryQuote = useCallback(() => {
    setStage((current) => {
      if (current.name !== 'quoteFailed') return current;
      // Same attempt, same body, same key: if the first POST reached the server
      // and we only lost the response, this replays it instead of creating a
      // second intent.
      void quote(current.amountFils, current.method, true);
      return current;
    });
  }, [quote]);

  const pay = useCallback(() => {
    setStage((current) => {
      if (current.name !== 'ready') return current;
      void settle(current.intent);
      return current;
    });
  }, [settle]);

  const retryOpen = useCallback(() => {
    setStage((current) => {
      if (current.name !== 'gatewayFailed') return current;
      void settle(current.intent);
      return current;
    });
  }, [settle]);

  const tryAgain = useCallback(
    (method?: PaymentMethod) => {
      setStage((current) => {
        if (current.name !== 'result' && current.name !== 'gatewayFailed') return current;
        // From `result` this is only ever reachable from declined/cancelled — the
        // pending screen has no control wired to it. From `gatewayFailed` it is
        // the "another method" escape, for the case where the rail she picked is
        // the thing whose page will not open.
        //
        // Either way the previous attempt is over as far as this app is concerned,
        // so this is a NEW attempt and gets a new key. That abandons the earlier
        // intent — unpaid, unconsumed, and reported: see the orphan note in the
        // lane's report.
        attemptKey.current = null;
        void quote(fils(current.intent.amountFils), method ?? current.intent.method, false);
        return current;
      });
    },
    [quote],
  );

  const close = useCallback(() => {
    setStage((current) => {
      if (!isDismissible(current)) return current;
      abort.current?.abort();
      attemptId.current += 1;
      attemptKey.current = null;
      return { name: 'closed' };
    });
  }, []);

  return { stage, open, chooseMethod, retryQuote, pay, retryOpen, tryAgain, close };
}
