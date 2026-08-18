/**
 * Customer-facing reads. The wallet's whole bootstrap lives here.
 *
 * `GET /members/me/wallet-token` mints the rotating QR. The client never mints
 * it (non-negotiable #2), the raw value is returned exactly once and stored only
 * as a sha256, and it lives 45 seconds. The countdown in the UI is cosmetic —
 * expiry and single-use consumption are decided here and in
 * services/walletToken.ts.
 */

import { randomInt } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { walletTokenUri } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { phoneChangeChallenge } from '../db/schema/phoneChange';
import { transaction } from '../db/schema/transaction';
import { hashSecret, verifySecret } from '../auth/password';
import {
  requireMember,
  requireScannerPerm,
  requireStaff,
  type StaffPrincipal,
} from '../auth/principal';
import { revokeOtherSessions } from '../auth/sessions';
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../http/errors';
import { serialiseTransactionForCustomer } from '../http/serialise';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { marketingConsentOf, recordConsent } from '../services/consent';
import { counterEnvelope } from '../services/counter';
import {
  DIRECTORY_REFUSED_ACTION,
  resolveMember,
  searchMembers,
} from '../services/memberSearch';
import { mintToken } from '../services/walletToken';
import { serialiseMember } from './auth';

/** api-contract.md rule 1: "short-lived". Long enough to read a message. */
const PHONE_CHANGE_TTL_MINUTES = 10;
/** "attempt-limited (lock after 5)". */
const PHONE_CHANGE_MAX_ATTEMPTS = 5;
/** "rate-limited per member per hour". */
const PHONE_CHANGE_PER_HOUR = 3;

/**
 * A 4-digit confirmation code. `randomInt` and not `Math.random`: this is a
 * credential, and a predictable one defeats the whole challenge.
 *
 * Four digits, matching the design's "4-digit confirmation" (the contract
 * allows 4–6). The space is small on purpose and is safe only because of what
 * surrounds it — five attempts, ten minutes, three challenges an hour, and an
 * argon2id hash at rest. That is the same argument the staff PIN makes.
 */
function mintNumericCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** E.164, the shape `member_phone_is_e164` enforces. */
function parseE164(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/[\s-]/g, '') : '';
  if (!/^\+[1-9][0-9]{6,14}$/.test(raw)) {
    throw badRequest(
      'invalid_phone',
      'Enter the number with its country code, like +96599123456.',
    );
  }
  return raw;
}

/**
 * An email, or null to clear it.
 *
 * Deliberately permissive: the only structural claim made here is that there is
 * something either side of an `@` and a dot in the domain. An address is proved
 * by sending to it, not by a regular expression, and a stricter pattern here
 * would reject valid addresses while proving nothing about the rest.
 */
function parseEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_email', 'email must be an address or null.');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw badRequest('invalid_email', 'That does not look like an email address.');
  }
  return trimmed.toLowerCase();
}

/** The five switches the Account screen draws. */
const NOTIFICATION_KEYS = new Set(['push', 'remind', 'wa', 'receipt', 'offers']);

/**
 * "Removed within 30 days" — the wallet's own copy, and the privacy policy's:
 * "the rest of your account data is deleted within 30 days of a deletion
 * request". The number is the promise, so it is named once, here.
 */
const DELETION_GRACE_DAYS = 30;

/**
 * The deletion state, on the wire.
 *
 * `erasureScheduled: false` is the honest part. The clock is real and the state
 * is real, but the job that does the erasing is not built — which columns are
 * nulled at the due date and which survive the 7-year financial record is a
 * retention decision that belongs to the client (CLAUDE.md § Open decisions).
 * A client must be able to tell "we have your request and the clock is running"
 * from "it has been carried out", and a response that implied the second would
 * make the confirmation screen say something untrue.
 */
function serialiseDeletion(m: typeof member.$inferSelect) {
  return {
    requestedAt: m.deletionRequestedAt?.toISOString() ?? null,
    erasureDueAt: m.deletionDueAt?.toISOString() ?? null,
    status: m.deletionRequestedAt ? ('pending' as const) : ('none' as const),
    graceDays: DELETION_GRACE_DAYS,
    erasureScheduled: false,
  };
}

/**
 * The screen-shaped response: four preferences and one consent, together.
 *
 * `offers` is flattened to a boolean so the switch has something to bind to,
 * and `offersConsent` carries the evidence beside it — when, from where, and
 * under which version of the terms. The client renders the boolean; support and
 * the send path read the rest. A response that carried only the boolean would
 * make the event storage pointless to everyone but the database.
 */
async function serialiseNotifications(m: typeof member.$inferSelect) {
  const offers = await marketingConsentOf(db, m.id);
  return {
    push: m.notifyPush,
    remind: m.notifyRemind,
    wa: m.notifyWa,
    receipt: m.notifyReceipt,
    offers: offers.granted,
    offersConsent: offers,
  };
}

async function loadMember(id: string): Promise<typeof member.$inferSelect> {
  const rows = await db.select().from(member).where(eq(member.id, id)).limit(1);
  const m = rows[0];
  if (!m) throw notFound('unknown_member', 'No such member.');
  return m;
}

/** The two audit columns every handler in this file fills the same way. */
function clientMeta(req: FastifyRequest): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * The scanner permission for a DIRECTORY read, with the refusal recorded.
 *
 * WHY A REFUSAL IS A DIRECTORY EVENT
 * ----------------------------------
 * `requireScannerPerm` throws before `searchMembers` runs, so the audit write
 * never happened and a staff member WITHOUT `perms.scanner` could probe the search
 * box and leave nothing behind. That contradicted the reasoning already written
 * into `resolveMember`, which writes its row BEFORE the 404 because "a refused id
 * is what a directory walk looks like from the inside". A refused authorisation is
 * the same argument one step earlier, and it is the step an unauthorised prober
 * takes.
 *
 * WHERE THE LINE IS, AND WHY IT IS NOT "LOG EVERYTHING"
 * ----------------------------------------------------
 * An audit row written from an unauthenticated request is an unbounded append-only
 * write into a table kept for seven years, reachable by anyone on the network with
 * no credential at all. So the rule is IDENTITY, not refusal:
 *
 *   401, no or invalid session        SILENT. `actorOf(null)` would name nobody,
 *                                     so the row answers no question, and the
 *                                     write needs no credential.
 *   a MEMBER token on a staff route   SILENT. She holds no `perms` to probe, and a
 *                                     customer account is cheap to obtain — logging
 *                                     it reopens the same flood vector through the
 *                                     signup form.
 *   STAFF, wrong surface              LOGGED. A dashboard session reaching a scanner
 *                                     directory read is an identified holder of a
 *                                     real staff credential.
 *   STAFF, missing perms.scanner      LOGGED. The case lane B reported, and the one
 *                                     an insider probing her own limits takes.
 *
 * So: authenticated, identified and refused is a fact worth keeping. Unidentified
 * noise is not.
 *
 * The refusal itself is still thrown by the canonical guard rather than rebuilt
 * here, so the copy the staff member reads stays in one place.
 *
 * NOT THROTTLED, deliberately. A retry loop could append rows, but every one of
 * them names the actor, so a flood is itself the signal — and inventing a cap
 * without having measured one is the mistake the 60/hour ceiling already taught.
 * If volume ever bites, the fix is a per-actor cap on refusal rows, not silence.
 */
async function requireDirectoryScanner(req: FastifyRequest): Promise<StaffPrincipal> {
  // 401 and the member-token case both throw out of here, unlogged.
  const p = requireStaff(req, 'either');

  if (p.scope === 'scanner' && p.perms.scanner) return p;

  await writeAudit(db, p, {
    salonId: p.salonId,
    kind: 'risk',
    action: DIRECTORY_REFUSED_ACTION,
    detail:
      p.scope === 'scanner'
        ? 'Attempted a customer lookup without scanner authority'
        : `Attempted a customer lookup from a ${p.scope} session`,
    source: 'scanner',
    subjectType: 'member_search',
    subjectId: null,
    metadata: {
      permission: 'scanner',
      scope: p.scope,
      hasPermission: p.perms.scanner,
      sessionId: p.sessionId,
    },
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  });

  // Throws the canonical 403 — wrong surface or missing permission, whichever it
  // is, with the message the staff member is meant to see.
  return requireScannerPerm(req, 'scanner');
}

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ GET /members --
  /**
   * MANUAL LOOKUP, for the customer whose phone is flat. The one route in this
   * file that a STAFF principal calls rather than a member — it is grouped here
   * because it reads the member table, and guarded like the scanner route it
   * backs up.
   *
   * `perms.scanner` — the same permission as `POST /scans`, because this is the
   * fallback for a scan that cannot happen, not a wider capability. A staff
   * member who may not scan may not look a customer up by name instead.
   *
   * Everything that makes a staff search box safe — salon scoping, minimum
   * query length, the rate limit and the audit row the design promises the
   * customer — is in services/memberSearch.ts, which explains each one.
   */
  app.get('/members', async (req, reply) => {
    const p = await requireDirectoryScanner(req);
    const { q } = (req.query ?? {}) as { q?: unknown };

    const items = await searchMembers(db, p, q, {
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send({ items, nextCursor: null });
  });

  app.get('/members/me', async (req, reply) => {
    const p = requireMember(req);
    return reply.send(serialiseMember(await loadMember(p.id)));
  });

  // ------------------------------------------------------- GET /members/:id --
  /**
   * RESOLVE ONE MEMBER, for a staff caller — the last step of the manual path.
   *
   * `GET /members?q=` returns a deliberately narrow row and nothing turned that
   * row into something the counter could act on, so "Can't scan? Find member
   * manually" ended at a name the scanner could display and could not charge —
   * in precisely the situation the fallback exists for.
   *
   * IT RETURNS THE `POST /scans` ENVELOPE, not a bare Member, and that is the
   * point: the two are doors onto one screen. `services/counter.ts` builds it for
   * both, so the held deposit cannot be right on one path and stale on the other
   * — which is a failure that path has already had once.
   *
   * REGISTERED AFTER `/members/me`, and it reads more honestly that way even
   * though it would work either way: find-my-way matches a static segment before a
   * parametric one, so `/members/me` can never be captured as `:id`. A member
   * principal reaching this route is refused by `requireScannerPerm` regardless.
   *
   * The tenant predicate, the shared directory-read ceiling and the audit row are
   * in services/memberSearch.ts § resolveMember, which explains each.
   */
  app.get<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
    const p = await requireDirectoryScanner(req);

    const m = await resolveMember(db, p, req.params.id, {
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(await counterEnvelope(db, serialiseMember(m), p.salonId));
  });

  // ------------------------------------------------------------ the profile --
  /**
   * api-contract.md § Profile edit: `PATCH /members/me { name?, email? } → Member`.
   *
   * RULE 1 IS THE POINT OF THIS HANDLER. "Phone is the login identity.
   * `PATCH /members/me` must reject a `phone` field." Not ignore it — reject
   * it. A route that silently drops the field answers 200 to a customer who
   * has just been shown her old number back and told it worked, and the next
   * person to widen the editable set turns that silence into an identity
   * change with no confirmation behind it. The phone moves through the
   * challenge pair below or it does not move.
   *
   * RULE 3: "email change clears `emailVerified` and sends a verification
   * link. Receipts keep going to the last verified address until the new one
   * is confirmed." The clearing is here. The link is not — there is no
   * customer notification outbox in this API (`receipt_job` is keyed to a
   * transaction, `merchant_notification` is the bell on the dashboard), and
   * inventing one for a single caller is a contract change this lane may not
   * make. Reported. What matters for the money is that `emailVerified` goes
   * false the moment the address changes, so nothing downstream can treat an
   * unconfirmed address as confirmed.
   */
  app.patch('/members/me', async (req, reply) => {
    const p = requireMember(req);

    const body = (req.body ?? {}) as Record<string, unknown>;

    if ('phone' in body) {
      throw badRequest(
        'phone_not_editable',
        'Your phone number is how you sign in, so it changes through a confirmation code. Start it from Account → Phone number.',
      );
    }

    // Everything else that is not `name` or `email` is refused by name rather
    // than dropped — including `balanceFils`, `tier` and `visits`, which are
    // the server's to decide (non-negotiable #2) and which a client sending
    // them is asking to set.
    const rejected = Object.keys(body).filter((k) => k !== 'name' && k !== 'email');
    if (rejected.length > 0) {
      throw badRequest(
        'not_editable',
        `These fields cannot be edited here: ${rejected.join(', ')}.`,
      );
    }
    if (Object.keys(body).length === 0) {
      throw badRequest('invalid_request', 'Nothing to change.');
    }

    const before = await loadMember(p.id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if ('name' in body) patch.name = requireString(body.name, 'name', 120);

    if ('email' in body) {
      const email = parseEmail(body.email);
      patch.email = email;
      // Rule 3. A new address is unconfirmed by definition, and clearing this
      // is what keeps receipts going to the last verified one.
      if (email !== before.email) patch.emailVerified = false;
    }

    const [after] = await db
      .update(member)
      .set(patch)
      .where(eq(member.id, p.id))
      .returning();
    if (!after) throw notFound('unknown_member', 'No such member.');

    await writeAudit(db, p, {
      salonId: after.salonId,
      kind: 'access',
      action: 'Profile changed',
      detail: `Changed: ${Object.keys(body).join(', ')}`,
      source: 'wallet',
      subjectType: 'member',
      subjectId: after.id,
      metadata: { changed: Object.keys(body) },
      ...clientMeta(req),
    });

    return reply.send(serialiseMember(after));
  });

  // ------------------------------------------------------- notifications --
  /**
   * The five switches on Account → Notifications, and they are NOT five
   * booleans. Lane B escalated this rather than inventing a contract, and its
   * reasoning is the design:
   *
   *   `push` and `remind` are plausibly client-owned — but held only on the
   *   client they are lost on reinstall, which silently re-enables everything
   *   the customer turned off.
   *
   *   `wa` and `receipt` ARE NOT CLIENT-OWNED AT ALL. The server sends both;
   *   the receipt outbox does not consult a phone before it queues a message.
   *   A local "off" does not stop a receipt, and the customer has been told it
   *   did. That is not a lost setting, it is a false statement made to her.
   *
   *   `offers` is MARKETING CONSENT, which non-negotiable #8 needs readable on
   *   the platform send path. It is stored as an append-only EVENT — see
   *   services/consent.ts — because a boolean cannot answer when she agreed,
   *   under which terms, or whether she had withdrawn it before, and those are
   *   the questions asked when somebody wants to know why a campaign arrived.
   *
   * So four columns and one event stream, behind one screen-shaped response.
   *
   * NO CONTRACT EXISTS FOR THIS. api-contract.md has no notification
   * preferences and packages/mock serves none; the shape below is new and is
   * reported to trunk rather than added to the contract from inside this lane.
   */
  app.get('/members/me/notifications', async (req, reply) => {
    const p = requireMember(req);
    const me = await loadMember(p.id);
    return reply.send(await serialiseNotifications(me));
  });

  app.patch('/members/me/notifications', async (req, reply) => {
    const p = requireMember(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rejected = Object.keys(body).filter((k) => !NOTIFICATION_KEYS.has(k));
    if (rejected.length > 0) {
      throw badRequest(
        'not_editable',
        `Unknown notification switch: ${rejected.join(', ')}. They are ${[...NOTIFICATION_KEYS].join(', ')}.`,
      );
    }
    if (Object.keys(body).length === 0) {
      throw badRequest('invalid_request', 'Nothing to change.');
    }

    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'boolean') {
        throw badRequest('invalid_request', `${key} must be true or false.`);
      }
    }

    const me = await loadMember(p.id);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if ('push' in body) patch.notifyPush = body.push;
    if ('remind' in body) patch.notifyRemind = body.remind;
    if ('wa' in body) patch.notifyWa = body.wa;
    if ('receipt' in body) patch.notifyReceipt = body.receipt;

    const offersChanged =
      'offers' in body && body.offers !== (await marketingConsentOf(db, me.id)).granted;

    const [after] = await db.transaction(async (tx) => {
      const updated =
        Object.keys(patch).length > 1
          ? await tx.update(member).set(patch).where(eq(member.id, me.id)).returning()
          : [me];

      /**
       * An event only when the ANSWER changes. Re-sending the same value is a
       * client re-rendering a screen, not the customer consenting again, and a
       * trail full of duplicate grants makes the real moment she agreed harder
       * to find rather than easier.
       */
      if (offersChanged) {
        await recordConsent(tx, {
          memberId: me.id,
          salonId: me.salonId,
          granted: body.offers as boolean,
          source: 'wallet_account',
          // The terms in force for her. See services/consent.ts.
          policyVersion: me.policyVersion,
          ...clientMeta(req),
        });

        await writeAudit(tx, p, {
          salonId: me.salonId,
          kind: 'access',
          action: body.offers ? 'Marketing consent given' : 'Marketing consent withdrawn',
          detail: `Offers ${body.offers ? 'on' : 'off'} · policy v${me.policyVersion}`,
          source: 'wallet',
          subjectType: 'member',
          subjectId: me.id,
          metadata: { granted: body.offers, policyVersion: me.policyVersion },
          ...clientMeta(req),
        });
      }

      return updated;
    });

    return reply.send(await serialiseNotifications(after ?? me));
  });

  // ---------------------------------------------------- account deletion --
  /**
   * "Removed within 30 days" — the promise the wallet's copy already makes, and
   * which had nothing behind it.
   *
   * A STATE WITH A CLOCK, not a support ticket. The reasoning is in migration
   * 0021 in full; the three steps are:
   *
   *   - it cannot be a hard delete. The privacy policy this API now serves says
   *     both "transaction records are kept for 7 years" and "the rest of your
   *     account data is deleted within 30 days". Two retention periods over one
   *     customer means deletion is an ERASURE OF PERSONAL DATA that leaves the
   *     money record standing — and `transaction`, `ledger_entry` and
   *     `audit_log` reference her with restrict/append-only anyway, so the
   *     database would refuse a DELETE regardless.
   *   - it cannot be a ticket. Who staffs the AVO queue and in what hours is
   *     still an open client decision, and a 30-day guarantee published in a
   *     legal document must not depend on a rota nobody has agreed.
   *   - so the clock is a database fact, on the row the eventual job reads.
   *
   * THE PASSWORD IS REQUIRED. This is the most destructive thing the wallet
   * offers and the session alone should not be enough — an unlocked handset on
   * a salon counter is the threat, and it is the same reasoning that makes
   * `POST /members/me/password` demand `current`.
   *
   * SESSIONS ARE NOT REVOKED, deliberately. The 30 days are a grace window, and
   * an account she is locked out of the moment she asks is one she cannot
   * change her mind about. `DELETE` below is that door.
   *
   * A NON-ZERO BALANCE IS REFUSED. Her wallet is prepaid credit the salon owes
   * her — non-negotiable #5 makes every refund wallet credit, and the terms say
   * a closing salon "must settle any remaining balance with you". Erasing the
   * account that names the money, while the money is still owed, is the one
   * outcome nobody can undo. Refused with the amount and the way out named.
   */
  /**
   * THE STATE, READABLE. The half of this feature that was missing.
   *
   * `POST` and `DELETE` both returned the deletion state, so the only way to
   * learn it was to change it — which meant a customer who requested erasure and
   * then closed the app had no way to find out that she had. She reopened it to
   * an Account screen identical to the one she had before, with the request
   * invisible and the cancel door unmarked.
   *
   * That is not a cosmetic gap. The 30 days are the promise the privacy policy
   * makes, and a grace window she cannot see is a grace window she cannot use:
   * the only remaining route to "actually, keep my account" is to guess that
   * pressing Delete again does something different. `DELETE` is the door and this
   * is the sign on it.
   *
   * WHY A SIBLING GET AND NOT A FIELD ON `GET /members/me`.
   * `MemberSchema` lives in `packages/types`, which is trunk-owned — this lane
   * may not widen it. And a member payload carrying `deletion` while the schema
   * does not declare it is the exact trap this project has now hit five times:
   * zod does not reject an undeclared field, it STRIPS it, so the state would
   * arrive at the client and vanish before any screen could read it. Widening the
   * shared schema is the trunk operation; serving the state beside the profile is
   * not, and it matches `GET /members/me/notifications`, which is unmodelled for
   * the same reason and read by the same screen.
   *
   * No permission gate beyond the session: this is her own account state, and it
   * is the same serialiser the two mutating handlers already return.
   */
  app.get('/members/me/deletion', async (req, reply) => {
    const p = requireMember(req);
    return reply.send(serialiseDeletion(await loadMember(p.id)));
  });

  app.post('/members/me/deletion', async (req, reply) => {
    const p = requireMember(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === 'string' ? body.password : '';

    const me = await loadMember(p.id);

    if (!(await verifySecret(me.passwordHash, password))) {
      throw unauthorized('That password does not match.', 'invalid_credentials');
    }

    if (me.deletionRequestedAt && me.deletionDueAt) {
      // Idempotent. Asking twice is one request, and must not restart the clock
      // — that would let a mis-tapped button quietly extend the 30 days.
      return reply.send(serialiseDeletion(me));
    }

    if (me.balanceFils > 0) {
      throw conflict('balance_outstanding', 'You still have credit in your wallet.', {
        balanceFils: me.balanceFils,
      });
    }

    const requestedAt = new Date();
    const dueAt = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000);

    const [after] = await db
      .update(member)
      .set({ deletionRequestedAt: requestedAt, deletionDueAt: dueAt, updatedAt: requestedAt })
      .where(eq(member.id, me.id))
      .returning();
    if (!after) throw notFound('unknown_member', 'No such member.');

    await writeAudit(db, p, {
      salonId: me.salonId,
      kind: 'access',
      action: 'Account deletion requested',
      detail: `Erasure due ${dueAt.toISOString().slice(0, 10)}`,
      source: 'wallet',
      subjectType: 'member',
      subjectId: me.id,
      metadata: { requestedAt: requestedAt.toISOString(), dueAt: dueAt.toISOString() },
      ...clientMeta(req),
    });

    return reply.send(serialiseDeletion(after));
  });

  /** The grace window is only real if she can use it. */
  app.delete('/members/me/deletion', async (req, reply) => {
    const p = requireMember(req);
    const me = await loadMember(p.id);

    if (!me.deletionRequestedAt) {
      throw notFound('no_deletion_request', 'There is no deletion request to cancel.');
    }

    const [after] = await db
      .update(member)
      .set({ deletionRequestedAt: null, deletionDueAt: null, updatedAt: new Date() })
      .where(eq(member.id, me.id))
      .returning();
    if (!after) throw notFound('unknown_member', 'No such member.');

    await writeAudit(db, p, {
      salonId: me.salonId,
      kind: 'access',
      action: 'Account deletion cancelled',
      detail: 'The account stays open',
      source: 'wallet',
      subjectType: 'member',
      subjectId: me.id,
      ...clientMeta(req),
    });

    return reply.send(serialiseDeletion(after));
  });

  // ------------------------------------------------- the phone change, part 1 --
  /**
   * api-contract.md § Profile edit rule 1. A code to the NEW number.
   *
   * WHAT THIS ENDPOINT DOES NOT DO IS THE INTERESTING PART: it does not move
   * the phone. Until `/verify` succeeds, `member.phone` is untouched and the
   * customer signs in with the old number — so an abandoned change, an
   * intercepted code that is never used, or a mistyped number all leave the
   * identity exactly where it was.
   *
   * RULE 2, AND THE HALF OF IT THAT IS ABOUT LEAKING. "A phone already in use
   * on the same salon is rejected before the code is sent — do not leak which
   * numbers exist beyond that." So the check runs here rather than at verify
   * (sending a code to a number that can never be claimed is a message to a
   * stranger), and the refusal says only that the number cannot be used at
   * this salon. It does not say whose it is, and it is scoped to the salon
   * because `member_salon_phone_uq` is: the same person may hold a wallet at
   * two salons, and one salon's roster is not another's to probe.
   *
   * THE RATE LIMIT is per member per hour, counted over rows. It is what stops
   * this endpoint being a free SMS cannon pointed at any number somebody types.
   */
  app.post('/members/me/phone-change', async (req, reply) => {
    const p = requireMember(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const newPhone = parseE164(body.phone);

    const me = await loadMember(p.id);
    if (newPhone === me.phone) {
      throw badRequest('phone_unchanged', 'That is already your number.');
    }

    // Rule 2, before anything is sent.
    const taken = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.salonId, me.salonId), eq(member.phone, newPhone)))
      .limit(1);
    if (taken[0]) {
      throw conflict(
        'phone_in_use',
        'That number cannot be used at this salon. Try another, or contact support.',
      );
    }

    const since = new Date(Date.now() - 60 * 60_000);
    const [recent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(phoneChangeChallenge)
      .where(
        and(
          eq(phoneChangeChallenge.memberId, me.id),
          gte(phoneChangeChallenge.createdAt, since),
        ),
      );
    if ((recent?.n ?? 0) >= PHONE_CHANGE_PER_HOUR) {
      throw tooManyRequests(
        'too_many_attempts',
        'Too many attempts. Wait an hour and try again.',
      );
    }

    const code = mintNumericCode();
    const expiresAt = new Date(Date.now() + PHONE_CHANGE_TTL_MINUTES * 60_000);

    const [row] = await db
      .insert(phoneChangeChallenge)
      .values({
        memberId: me.id,
        salonId: me.salonId,
        newPhone,
        oldPhone: me.phone,
        codeHash: await hashSecret(code),
        expiresAt,
      })
      .returning();
    if (!row) throw conflict('challenge_not_created', 'That could not be started. Try again.');

    await writeAudit(db, p, {
      salonId: me.salonId,
      kind: 'access',
      action: 'Phone change started',
      // The NUMBER is the subject of the change and belongs on the row; the
      // CODE never does. An audit log is read by more people than this
      // response is.
      detail: `Code sent to ${newPhone}`,
      source: 'wallet',
      subjectType: 'member',
      subjectId: me.id,
      metadata: { challengeId: row.id, newPhone },
      ...clientMeta(req),
    });

    /**
     * DELIVERY IS NOT WIRED, and this response does not pretend it is.
     *
     * There is no customer notification sender in this API for the reason
     * receipts/types.ts sets out at length: the WhatsApp templates are
     * unapproved and the sending domain is an open client decision. Both are
     * the client's to settle and neither is waiting on code. `codeSent: false`
     * says so rather than letting a client render "we've texted you".
     *
     * The code is NOT in this body and must never be. That would make the
     * whole challenge theatre — anyone holding the session could read it and
     * verify immediately, which is precisely the property the second factor
     * exists to deny.
     */
    return reply.send({
      challengeId: row.id,
      expiresAt: expiresAt.toISOString(),
      newPhone,
      codeSent: false,
    });
  });

  // ------------------------------------------------- the phone change, part 2 --
  /**
   * api-contract.md § Profile edit rule 1, the far half:
   * `POST /members/me/phone-change/{challengeId}/verify { code } → Member`.
   *
   * "Attempt-limited (lock after 5)". The counter is incremented BEFORE the
   * code is compared, so a request that dies mid-flight has still been paid
   * for — a counter bumped only on a confirmed mismatch is a counter an
   * attacker can avoid by hanging up.
   *
   * Rule 2 is re-checked here as well as at creation. Between the two requests
   * somebody else may have taken the number, and the uniqueness index would
   * refuse the UPDATE as a 500. The window is small and the failure is a
   * customer losing her login identity to a constraint violation, so it is
   * closed with a sentence.
   *
   * EVERY SESSION BUT THIS ONE IS REVOKED, the same rule a password change
   * follows and for a stronger reason: the login identity itself has moved.
   */
  app.post<{ Params: { id: string } }>(
    '/members/me/phone-change/:id/verify',
    async (req, reply) => {
      const p = requireMember(req);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const code = typeof body.code === 'string' ? body.code.trim() : '';

      const rows = await db
        .select()
        .from(phoneChangeChallenge)
        .where(
          and(
            eq(phoneChangeChallenge.id, req.params.id),
            // Scoped to the caller in the predicate, not checked afterwards.
            // Another member's challenge is `unknown_challenge`, identical to
            // one that does not exist.
            eq(phoneChangeChallenge.memberId, p.id),
          ),
        )
        .limit(1);
      const challenge = rows[0];

      const DEAD = () =>
        badRequest(
          'challenge_expired',
          'That confirmation has expired or has already been used. Start again from Account.',
        );

      if (!challenge) throw notFound('unknown_challenge', 'No such confirmation.');
      if (challenge.verifiedAt || challenge.lockedAt) throw DEAD();
      if (challenge.expiresAt.getTime() <= Date.now()) throw DEAD();

      // Paid for before it is checked. See the header.
      const attempts = challenge.attempts + 1;
      const locked = attempts >= PHONE_CHANGE_MAX_ATTEMPTS;
      await db
        .update(phoneChangeChallenge)
        .set({ attempts, ...(locked ? { lockedAt: new Date() } : {}) })
        .where(eq(phoneChangeChallenge.id, challenge.id));

      if (!(await verifySecret(challenge.codeHash, code))) {
        if (locked) {
          throw badRequest(
            'challenge_locked',
            'Too many wrong codes. Start the change again from Account.',
          );
        }
        throw badRequest('invalid_code', 'That code is not right. Check the message and try again.');
      }

      const me = await loadMember(p.id);

      // Rule 2, re-checked. Somebody may have taken the number since.
      const taken = await db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.salonId, me.salonId), eq(member.phone, challenge.newPhone)))
        .limit(1);
      if (taken[0]) {
        throw conflict(
          'phone_in_use',
          'That number cannot be used at this salon any more. Start again with another.',
        );
      }

      const now = new Date();
      const [after] = await db.transaction(async (tx) => {
        const updated = await tx
          .update(member)
          .set({ phone: challenge.newPhone, updatedAt: now })
          .where(eq(member.id, me.id))
          .returning();

        await tx
          .update(phoneChangeChallenge)
          .set({ verifiedAt: now })
          .where(eq(phoneChangeChallenge.id, challenge.id));

        await writeAudit(tx, p, {
          salonId: me.salonId,
          kind: 'access',
          action: 'Phone number changed',
          detail: `${challenge.oldPhone} → ${challenge.newPhone}`,
          source: 'wallet',
          subjectType: 'member',
          subjectId: me.id,
          metadata: {
            challengeId: challenge.id,
            oldPhone: challenge.oldPhone,
            newPhone: challenge.newPhone,
            /**
             * Rule 1's last clause — "Notify the OLD number that the change
             * happened" — recorded as OWED, not as done. There is no customer
             * notification sender (see the note on the endpoint above), and
             * writing `notified: true` here would be the audit log asserting
             * something that did not happen. Reported as a gap.
             */
            oldNumberNoticeOwed: true,
          },
          ...clientMeta(req),
        });

        return updated;
      });

      if (!after) throw notFound('unknown_member', 'No such member.');

      // The identity moved. Every other device drops, exactly as on a password
      // change — the caller keeps the session she did this from.
      await revokeOtherSessions(db, { kind: 'member', id: me.id }, p.sessionId, 'phone_change');

      return reply.send(serialiseMember(after));
    },
  );

  /**
   * The activity feed, through the SHARED serialiser.
   *
   * This handler used to map its rows inline. The mapping was correct — it
   * listed its fields and `feeFils` was not among them — and that is exactly
   * why it was worth changing. `http/serialise.ts` exists so that
   * "merchant-visible, customer-never" is a place in the code rather than a
   * habit; a second, parallel mapping of the same row makes it a habit again.
   *
   * Lane D found it: the rule was enforced in the shared serialiser and this,
   * the single most fee-adjacent customer read in the API, did not call it. The
   * next person to add a column to `transaction` and widen the wrong `select`
   * would have had nothing to stop them here.
   */
  app.get('/members/me/transactions', async (req, reply) => {
    const p = requireMember(req);

    /**
     * THE SELF-JOIN THAT MAKES THE VOID STATE REAL.
     *
     * `TransactionSchema` requires `voidedAt` and `reversedByTransactionId`, and
     * neither is a column: void state lives on the REVERSAL, which points back
     * here through `reverses_transaction_id`. This handler served neither, and a
     * cast inside the serialiser stopped tsc from saying so — so the wallet's
     * contract parse rejected every non-empty feed, Home rendered "We couldn't
     * load your wallet", and Account became unreachable behind it.
     *
     * The same shape `GET /charges` uses, and for the reason stated there: a
     * self-join rather than a second query, so the flag cannot disagree with the
     * row it is attached to. `reverses_transaction_id` is uniquely indexed, so
     * this matches at most one reversal per transaction and cannot duplicate a
     * row.
     */
    const reversal = alias(transaction, 'reversal');

    const rows = await db
      .select({ tx: transaction, reversal })
      .from(transaction)
      .leftJoin(reversal, eq(reversal.reversesTransactionId, transaction.id))
      .where(eq(transaction.memberId, p.id))
      .orderBy(desc(transaction.createdAt))
      .limit(50);

    return reply.send({
      // No `as TransactionRow` here either. The row satisfies the interface
      // structurally; the cast was only ever hiding whether it did.
      items: rows.map(({ tx, reversal: v }) => serialiseTransactionForCustomer(tx, v)),
      nextCursor: null,
    });
  });

  /** Server-minted, 45s, single use. Returned once — only its hash is stored. */
  app.get('/members/me/wallet-token', async (req, reply) => {
    const p = requireMember(req);
    const minted = await mintToken(db, p.id);
    return reply.send({
      memberId: minted.memberId,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      uri: walletTokenUri(minted.memberId, minted.token),
    });
  });
}
