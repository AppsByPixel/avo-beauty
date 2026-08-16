/**
 * The top-up state machine.
 *
 * Four stages the customer can see — choose, redirect, result, and the failure
 * of the quote itself — expressed as a discriminated union so that "which screen
 * am I on" and "what data does that screen have" cannot drift apart. A `result`
 * stage without an intent does not type-check, which is the point: every one of
 * the four outcome screens is rendered from a real server response.
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
import { fils, type Fils, type PaymentMethod, type TopUpIntent } from '@avo/types';
import { ApiError, newIdempotencyKey, type FailureKind } from '../api/client';
import { createTopUp, getTopUp } from '../api/topups';
import { openGateway } from '../platform/gateway';
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
  | { name: 'ready'; intent: TopUpIntent }
  /** At the bank. NOT DISMISSIBLE — see interaction-spec.md §2. */
  | { name: 'redirect'; intent: TopUpIntent }
  /** One of exactly four outcomes, from GET /topups/{id} and nowhere else. */
  | { name: 'result'; intent: TopUpIntent; outcome: TopUpOutcome };

/**
 * The one place a stage is allowed to say whether it can be dismissed.
 *
 * interaction-spec.md §2: "`Esc` closes — **except** the KNET redirect state,
 * which is deliberately not dismissible." The customer is at her bank. Closing
 * the sheet would strand a live payment behind a screen that no longer exists,
 * and she would reasonably start another one.
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
   */
  const settle = useCallback(async (intent: TopUpIntent) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const attempt = (attemptId.current += 1);

    setStage({ name: 'redirect', intent });

    const session = openGateway(intent.redirectUrl);
    let hinted = false;
    let delay = FIRST_POLL_MS;
    let failures = 0;

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

  const tryAgain = useCallback(
    (method?: PaymentMethod) => {
      setStage((current) => {
        if (current.name !== 'result') return current;
        // Only ever reachable from declined/cancelled — the pending screen has no
        // control wired to this. The previous attempt is terminally over, so this
        // is a new attempt and gets a new key.
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

  return { stage, open, chooseMethod, retryQuote, pay, tryAgain, close };
}
