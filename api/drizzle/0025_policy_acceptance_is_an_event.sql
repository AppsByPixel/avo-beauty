-- ===========================================================================
-- 0025 - policy acceptance as an EVENT, and a member number that cannot collide
--
-- NON-NEGOTIABLE #10: "The customer app holds no legal copy. It renders the
-- published policy set from the API and stamps the version. Store the accepted
-- version against the member."
--
-- The member half (`member.policy_version`) has existed since 0000 and the
-- document half since 0019, and #10 was still unmet — because there was no
-- moment at which acceptance HAPPENED. `auth.ts` had sign-in, refresh, sign-out
-- and a staff reset, and no registration. Every `member.policy_version` in the
-- database was written by a seed script, not by a customer agreeing to anything.
--
-- WHY THIS IS THE SAME TABLE AS MARKETING CONSENT
-- ----------------------------------------------
-- 0020 predicted this exact use in its own comment — "the next one is already
-- visible: non-negotiable #10's acceptance of a NEW policy version is the same
-- shape of fact" — and left `member_consent_source_is_known` already permitting
-- `'signup'`, which is a second confirmation from the enum rather than from the
-- prose. So the only thing in the way was `member_consent_kind_is_known`, and
-- widening it is this migration.
--
-- `member.policy_version` STAYS. It is the cached current value, exactly as the
-- notify_* booleans relate to nothing and the `offers` projection relates to its
-- event stream: cheap to read on every request, and NOT the evidence. The
-- evidence is here, in a table with UPDATE and DELETE revoked from the
-- application role (0020) and UPDATE and TRUNCATE refused even to the owner
-- (0023).
--
-- And it is the event, not the column, that answers #10's SECOND half.
-- "Re-prompt on a material change" needs "has she accepted the version that is
-- published NOW", and a column that is overwritten on each acceptance cannot be
-- asked that about any version but the latest. A history can.
--
-- WHY A POLICY ACCEPTANCE IS NEVER A WITHDRAWAL
-- --------------------------------------------
-- 0020: "`granted = false` is a withdrawal event, not the absence of a grant."
-- For marketing that is a real fact a customer can create — she turns offers
-- off. For policy acceptance there is no such flow and no such fact: the
-- product's answer to "I no longer agree to the terms" is account deletion
-- (0021), not a row here. A `granted = false` acceptance row would therefore be
-- a false statement in an append-only table, which is the one thing this table
-- must not contain, so the CHECK refuses it outright.
--
-- TO REVERSE: if the re-prompt ever needs to record a DECLINE — she is shown v5
-- and taps no — that is a different fact from withdrawing a consent she gave,
-- and it deserves its own `kind` and its own decision about what happens to her
-- access. Widening this CHECK to allow `granted = false` would smuggle that
-- decision in as a data shape. Add a kind instead.
--
-- WHY ACCEPTING ONE VERSION TWICE IS REFUSED BY THE DATABASE
-- ---------------------------------------------------------
-- "She accepted v4" is one fact however many times the button is tapped, and the
-- re-prompt screen is exactly the place a double tap happens. The partial unique
-- index makes the second tap a no-op the handler can recognise rather than a
-- duplicate row, and it is the same instinct as `member_salon_phone_uq` catching
-- two taps on Create account. Marketing consent is deliberately NOT covered:
-- off-on-off over a year is three real facts.
-- ===========================================================================

ALTER TABLE member_consent_event DROP CONSTRAINT member_consent_kind_is_known;
ALTER TABLE member_consent_event ADD CONSTRAINT member_consent_kind_is_known
  CHECK (kind IN ('marketing_offers', 'policy_acceptance'));

ALTER TABLE member_consent_event ADD CONSTRAINT member_consent_acceptance_is_never_withdrawn
  CHECK (kind <> 'policy_acceptance' OR granted = true);

CREATE UNIQUE INDEX member_consent_acceptance_once_per_version
  ON member_consent_event (member_id, policy_version)
  WHERE kind = 'policy_acceptance';

-- ===========================================================================
-- THE MEMBER NUMBER
--
-- `member.id` is the customer-facing number — api-contract.md § Member: `"8842"
-- surfaces as "ID · 8842"`, and services/memberSearch.ts matches it EXACTLY
-- rather than as a substring precisely because "ids are short, dense and
-- sequential". Nothing in the API has ever minted one; both existing rows come
-- from the seed script.
--
-- A SEQUENCE, NOT A RANDOM NUMBER. Four digits is 9,000 values, so `SUP-`/`CMP-`
-- style `Math.random()` minting would start colliding on a primary key almost
-- immediately — and the collision surfaces as a failed signup for a real
-- customer, at the worst possible moment, with a retry loop as the only cure.
-- The sequence cannot collide and needs no loop.
--
-- START WITH 90000 puts every minted number clearly outside the four-digit
-- fixture range (8842, 8843), so a seeded database and a signed-up member can
-- never contend for the same primary key.
--
-- Enumerability is accepted rather than overlooked: a sequential id tells an
-- observer roughly how many members a salon has. It buys nothing else — the id
-- is not a credential anywhere. The QR carries a rotating single-use token
-- (services/walletToken.ts), `GET /members/{id}` is salon-scoped and
-- permission-gated, and it already audits an id that is not in the caller's
-- salon. A four-digit space was enumerable regardless of how it was filled.
--
-- `avo_app` gets USAGE via the ALTER DEFAULT PRIVILEGES in 0001, which covers
-- sequences created later by the migration owner.
-- ===========================================================================

CREATE SEQUENCE IF NOT EXISTS member_number_seq AS bigint START WITH 90000;
