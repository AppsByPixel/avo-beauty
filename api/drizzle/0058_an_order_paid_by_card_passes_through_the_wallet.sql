-- ===========================================================================
-- AN ORDER PAID BY CARD PASSES THROUGH THE WALLET
--
-- Client ask 2 (wallet list): "add payment methods in the shop".
--
-- There is exactly one path to the payment gateway — the top-up — and it
-- carries the machinery a second path would have to re-earn: the idempotency
-- key that a failed gateway leg does not burn, the timeout, the state machine
-- and its trigger (0004), the webhook's event index, the reaper, and the specs
-- in e2e/gateway.test.ts and money.test.ts. So a shop order paid by KNET, card
-- or Apple Pay is A TOP-UP INTENT SIZED TO THE ORDER, WITH THE ORDER ATTACHED,
-- and the order is placed inside the transaction that credits the top-up:
--
--   card charged → amount credited to the wallet → the order debits it
--
-- all in `services/topup.ts § creditWallet`'s one transaction. That keeps
-- non-negotiable #2 (the server decided it was paid), #5 (a later refund is
-- wallet credit, because the money passed through the wallet) and #3's spirit
-- (credit and debit commit together).
--
-- THE RACE. If the order cannot be placed when the payment confirms — the
-- product was retired, its price changed, the shop module was switched off, the
-- address was deleted — the order's writes roll back to a SAVEPOINT and the
-- credit does not. The money is in her wallet, the intent records why the order
-- was refused, and she can see both. A card charge can never become a
-- disappearance; the worst case is a balance she did not mean to hold.
--
-- ---------------------------------------------------------------------------
-- THE COLUMNS
-- ---------------------------------------------------------------------------
--   order_request         what she asked for: items (product id + qty),
--                         fulfilment, address id. NULL on an ordinary top-up.
--                         Prices are NOT stored here — the order is re-priced
--                         at settlement and refused if the total moved (see
--                         `order_refusal_code = 'price_changed'`).
--   order_transaction_id  the `shop` transaction the settlement placed.
--   order_refusal_code    why it was not placed — an ApiError code the wallet
--   order_refusal_message can branch on, and the sentence she is shown.
--   order_result          the placed order's OrderResult, frozen, so the wallet
--                         can draw the same receipt `POST /orders` answers with.
--
-- The CHECKs make every settled card-paid order ANSWERED: placed or refused,
-- never neither and never both, and never before the money settled.
-- ===========================================================================

ALTER TABLE "topup_intent"
  ADD COLUMN "order_request" jsonb,
  ADD COLUMN "order_transaction_id" text,
  ADD COLUMN "order_refusal_code" text,
  ADD COLUMN "order_refusal_message" text,
  ADD COLUMN "order_result" jsonb;

ALTER TABLE "topup_intent"
  ADD CONSTRAINT "topup_intent_order_transaction_id_transaction_id_fk"
    FOREIGN KEY ("order_transaction_id") REFERENCES "transaction"("id") ON DELETE restrict;

-- One order per payment, as an index rather than as a promise — the shape of
-- `topup_intent_transaction_uq` one column over.
CREATE UNIQUE INDEX "topup_intent_order_transaction_uq"
  ON "topup_intent" ("order_transaction_id")
  WHERE "order_transaction_id" IS NOT NULL;

ALTER TABLE "topup_intent"
  -- An outcome belongs to an order request. A plain top-up has neither.
  ADD CONSTRAINT "topup_intent_order_outcome_needs_request"
    CHECK ("order_request" IS NOT NULL
           OR ("order_transaction_id" IS NULL AND "order_refusal_code" IS NULL
               AND "order_result" IS NULL)),
  -- Placed or refused, never both.
  ADD CONSTRAINT "topup_intent_order_placed_or_refused"
    CHECK ("order_transaction_id" IS NULL OR "order_refusal_code" IS NULL),
  -- A refusal has a reason she can read, and a reason is a refusal.
  ADD CONSTRAINT "topup_intent_order_refusal_is_whole"
    CHECK (("order_refusal_code" IS NULL) = ("order_refusal_message" IS NULL)),
  -- The frozen receipt exists exactly when an order was placed.
  ADD CONSTRAINT "topup_intent_order_result_matches_placement"
    CHECK (("order_result" IS NULL) = ("order_transaction_id" IS NULL)),
  -- AN ANSWER EXISTS EXACTLY WHEN THE MONEY SETTLED. Written as an equivalence
  -- so it bites both ways, the lesson `topup_intent_succeeded_has_settled_at`
  -- records: an outcome on an unpaid intent would be an order placed without
  -- money, and a settled order request with no outcome is a card charge whose
  -- order nobody decided.
  ADD CONSTRAINT "topup_intent_settled_order_is_answered"
    CHECK ("order_request" IS NULL
           OR ("status" = 'succeeded')
              = ("order_transaction_id" IS NOT NULL OR "order_refusal_code" IS NOT NULL));
