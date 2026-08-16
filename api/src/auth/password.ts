/**
 * Password and PIN hashing. argon2id, per LANES.md lane A and non-negotiable #6:
 * "never plaintext, never returned by an endpoint, never shown in a UI".
 *
 * A PIN gets the SAME hash function as a password, and that is worth stating
 * because the instinct is to treat four digits as not worth the cost. The
 * opposite is true: a 4-digit PIN has 10,000 possibilities, so if the hash is
 * cheap the entire space falls in under a second against a stolen database
 * dump. argon2id at these parameters makes an offline sweep of one PIN cost
 * hours instead. It is not a substitute for the online controls — the device
 * scoping, the rate limit and the lockout in staff.ts are what stop the ONLINE
 * attack — but it is what keeps a dump from being a list of PINs.
 *
 * Verification is constant-time inside argon2 itself, so there is no timing
 * comparison to get wrong here. `verifyPassword` swallows argon2's own errors
 * and returns false: a malformed stored hash is an authentication failure, not
 * a 500 that tells the caller the record exists.
 */

import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP's second recommended argon2id profile (19 MiB, t=2, p=1). Chosen over
 * the 64 MiB profile because the scanner signs in on every shift change and the
 * API pays this cost synchronously; 19 MiB still puts an offline attack far out
 * of reach of a commodity GPU.
 *
 * `algorithm` is left at the library default, which is Argon2id — the enum is an
 * ambient const enum and `verbatimModuleSyntax` cannot import one as a value.
 * Relying on a default for something this load-bearing is not good enough on its
 * own, so `hashSecret` asserts the variant out of the encoded hash instead. That
 * is a stronger check than the enum would have been: it verifies what was
 * actually produced rather than what was requested.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashSecret(plaintext: string): Promise<string> {
  const digest = await hash(plaintext, OPTIONS);
  if (!digest.startsWith('$argon2id$')) {
    // argon2i and argon2d are not acceptable here: argon2id is the variant with
    // both the side-channel and the GPU-cracking resistance.
    throw new Error(`Expected an argon2id hash, got ${digest.slice(0, 12)}`);
  }
  return digest;
}

/** False on a wrong secret AND on a malformed stored hash. Never throws. */
export async function verifySecret(storedHash: string | null, plaintext: string): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A dummy verify, for the branch where the account does not exist.
 *
 * Without it, "unknown handle" returns in microseconds while "known handle,
 * wrong PIN" takes the full argon2 cost, and the difference enumerates the
 * staff list. Burning the same work on the miss path removes the signal.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Iy1M0nQPX0k5bqZ1o8wJcYbLK0k9zVQ0Zr8Fq7bXpQ0';

export async function burnVerifyTime(plaintext: string): Promise<void> {
  try {
    await verify(DUMMY_HASH, plaintext, OPTIONS);
  } catch {
    // Expected — the point is the elapsed time, not the result.
  }
}

// --------------------------------------------------------------- policies --

/**
 * api-contract.md § Profile edit rule 4: "enforces a minimum length of 6 (the
 * client says so; enforce it server-side too)".
 */
export const MIN_PASSWORD_LENGTH = 6;

export function isAcceptablePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH;
}

/** Exactly four digits. Not "at least", not "digits somewhere in there". */
export function isFourDigitPin(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}
