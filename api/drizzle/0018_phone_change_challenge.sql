-- ===========================================================================
-- 0018 - changing the phone number, which is the login identity
--
-- api-contract.md § Profile edit, rule 1: "Phone is the login identity.
-- `PATCH /members/me` must reject a `phone` field. A change goes through the
-- challenge endpoints: a 4-6 digit code to the NEW number, short-lived,
-- attempt-limited (lock after 5), rate-limited per member per hour. Notify the
-- OLD number that the change happened."
--
-- WHY A TABLE AND NOT A COLUMN ON `member`
--
-- A challenge is an attempt, not a property of the customer. Two of them can be
-- live at once in the ordinary case where somebody mistypes the number and
-- starts again, and the rate limit — "per member per hour" — is a COUNT over
-- attempts, which a single column cannot express. The row is also the audit
-- trail of a login identity moving, which is the most security-sensitive edit
-- the wallet offers.
--
-- THE CODE IS HASHED, with argon2id, exactly as the staff PIN is and for the
-- same reason db/schema/staff.ts gives: four digits is 10,000 possibilities, so
-- a cheap digest over a stolen dump is a list of live codes. The online attack
-- is stopped by `attempts` and the lockout; the hash is what keeps a dump from
-- being useful. It costs ~50ms on a path a customer takes once.
--
-- `new_phone` IS STORED IN CLEAR, deliberately. It is the value being moved to,
-- the customer typed it, and the verify step has to compare the row against the
-- uniqueness index before it writes. Hashing it would make the "already in use
-- at this salon" check impossible without a second plaintext copy somewhere.
--
-- NO UNIQUE INDEX ON `new_phone`. Rule 2 says a phone already in use at the
-- salon is rejected "before the code is sent", and that check belongs against
-- `member`, not against other people's pending challenges: two customers who
-- both mistype the same number should each get their own refusal, not a
-- collision that tells the second one somebody else is mid-change.
-- ===========================================================================

CREATE TABLE phone_change_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    text NOT NULL REFERENCES member (id) ON DELETE cascade,
  salon_id     text NOT NULL REFERENCES salon (id) ON DELETE restrict,

  -- Where the identity is moving to, and where it is moving from. `old_phone`
  -- is copied in rather than read from `member` at verify time: it is the
  -- number the notice is owed to, and it must be the number as it was when the
  -- change was started.
  new_phone    text NOT NULL,
  old_phone    text NOT NULL,

  -- argon2id over the 4-digit code. Never the code.
  code_hash    text NOT NULL,

  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  verified_at  timestamptz,
  -- Set when the attempt limit is hit. A locked challenge is dead; the customer
  -- starts a new one, which the hourly rate limit then counts.
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phone_change_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT phone_change_new_phone_is_e164 CHECK (new_phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT phone_change_expires_after_creation CHECK (expires_at > created_at)
);

-- The rate-limit query: challenges by this member since a cutoff.
CREATE INDEX phone_change_member_created_idx
  ON phone_change_challenge (member_id, created_at DESC);

-- GRANTS: covered by the ALTER DEFAULT PRIVILEGES in migration 0001.
