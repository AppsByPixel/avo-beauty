-- ===========================================================================
-- A WORKSPACE CAN KEEP ITS OWN COLOUR ON THE WALLET CARD.
--
-- Aftab, 2026-09-29: "if there is a user for a separate workspace and that
-- workspace has a dark green theme chosen then it should override this tier
-- coloring for that workspace."
--
-- The wallet's main card takes the member's tier metal since 08330d1 (silver
-- is silver, gold is gold). `SalonSchema.walletCard` in `@avo/types` (fd6edc8)
-- is the salon's choice over that:
--
--   'tier'   the member's tier colour. THE DEFAULT, and every existing salon's
--            value, so no card changes colour when this applies.
--   'brand'  the salon's own `brand_color` on every card, whatever her tier.
--
-- Served by `serialiseSalon`, written through `PATCH /salons/{id}`,
-- `PATCH /v1/platform/salons/{id}` and `POST /v1/platform/salons` — the three
-- doors `brand_color` has, under the same gates. `parseWalletCard` refuses
-- anything else with 400 `invalid_wallet_card`; `salon_wallet_card_known` is
-- the guarantee under it, for a write that bypasses the route.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API — production is on 0068, its API is 405b20f
-- ---------------------------------------------------------------------------
-- ADDITIVE. One column, one CHECK, nothing rewritten or dropped.
--
--   READS. The deployed API selects the columns its own schema names, so it
--   never asks for `wallet_card` and serves no `walletCard`. A wallet parsing
--   that through `SalonSchema` gets `.default('tier')`: today's card.
--
--   WRITES. Its onboarding INSERT names no `wallet_card`, so the column default
--   fills 'tier'. Its PATCH never mentions the column. Nothing the old API can
--   send is refused by the new CHECK.
--
-- LOCKING. `ADD COLUMN … NOT NULL DEFAULT 'tier'` with a constant default is a
-- catalogue change on Postgres 11+ (no table rewrite), held under ACCESS
-- EXCLUSIVE for milliseconds. `ADD CONSTRAINT … CHECK` then scans `salon` — one
-- row per workspace — under the same lock. lock_timeout 3s, the
-- 0010/0011/0059/0063..0068 convention: `salon` is read inside every charge.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

ALTER TABLE "salon" ADD COLUMN "wallet_card" text DEFAULT 'tier' NOT NULL;--> statement-breakpoint
ALTER TABLE "salon" ADD CONSTRAINT "salon_wallet_card_known" CHECK ("wallet_card" IN ('tier', 'brand'));--> statement-breakpoint

RESET lock_timeout;
