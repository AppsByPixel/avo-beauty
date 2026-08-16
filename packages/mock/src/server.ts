/**
 * Mock API. `pnpm mock` → http://localhost:4000
 *
 * This is what lanes B (wallet) and C (dashboard) build against so they never
 * wait on lane A. It serves the shapes in packages/types, which means a contract
 * change breaks the mock's own typecheck — the mock cannot silently drift from
 * what the real API will return.
 *
 * SCENARIOS
 * ---------
 * Every route honours a scenario, set by header or query string:
 *
 *   curl localhost:4000/members/me -H 'x-avo-scenario: offline'
 *   http://localhost:4000/members/me?scenario=empty
 *
 * This is how the four required states (interaction-spec.md §4) get built
 * alongside the happy path instead of after it:
 *
 *   ok         the happy path (default)
 *   loading    responds after 3s — for exercising skeletons
 *   empty      a member who joined today: no history, nothing booked
 *   error      500
 *   offline    503, connection-style failure
 *   stamps     the salon in stamps mode rather than tiers
 *   declined   top-up: gateway declined
 *   cancelled  top-up: customer backed out at the gateway
 *   pending    top-up: bank hasn't settled — its own screen, NO retry offered
 *   lowbal     charge: rejected with the exact shortfall
 *   noperms    staff session with charges/void off — proves the 403
 */

import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  add,
  commissionFor,
  fils,
  percentOf,
  subtract,
  walletTokenUri,
  type Fils,
  type TopUpIntent,
  type Transaction,
} from '@avo/types';
import {
  BRANCH_SALMIYA,
  SALON_ID,
  artists,
  campaigns,
  member,
  memberStamps,
  policies,
  products,
  promotions,
  salon,
  services,
  staff,
  support,
  transactions,
} from './fixtures.js';

const PORT = Number(process.env.PORT ?? 4000);

type Scenario =
  | 'ok'
  | 'loading'
  | 'empty'
  | 'error'
  | 'offline'
  | 'stamps'
  | 'declined'
  | 'cancelled'
  | 'pending'
  | 'lowbal'
  | 'noperms';

/**
 * Scenarios combine: `x-avo-scenario: empty,stamps` is a brand-new member at a
 * stamps salon. A single-value flag couldn't express that, and those crossings
 * are exactly where state bugs live.
 */
function scenariosOf(req: FastifyRequest): Set<Scenario> {
  const header = req.headers['x-avo-scenario'];
  const query = (req.query as Record<string, string> | undefined)?.scenario;
  const raw = (Array.isArray(header) ? header[0] : header) ?? query ?? 'ok';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as Scenario[],
  );
}

function has(req: FastifyRequest, name: Scenario): boolean {
  return scenariosOf(req).has(name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Applies the scenarios that short-circuit a response. Returns true when the
 * request has been handled and the route should stop.
 */
async function intercept(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (has(req, 'loading')) await sleep(3000);
  if (has(req, 'error')) {
    await reply.code(500).send({ error: 'server_error', message: 'Something went wrong on our side.' });
    return true;
  }
  if (has(req, 'offline')) {
    await reply
      .code(503)
      .send({ error: 'unavailable', message: 'No connection. Showing your last update.' });
    return true;
  }
  return false;
}

const app = Fastify({ logger: { transport: { target: 'pino-pretty' } } });
await app.register(cors, { origin: true });

/**
 * Idempotency keys seen this process, so a replay returns the first result.
 *
 * SCOPED PER ENDPOINT. A single global map keyed on the header alone means a key
 * used on POST /topups is honoured by POST /charges — the charge returns a
 * TopUpIntent and never debits. Lane A must scope on (principal, endpoint, key),
 * with the row inserted inside the same transaction as the effect.
 */
const idempotency = new Map<string, unknown>();
/** Top-up intents by their real id, so GET /topups/{id} can look one up. */
const topups = new Map<string, TopUpIntent>();
/** Wallet tokens issued and not yet consumed. Single use — non-negotiable #2. */
const liveTokens = new Map<string, { memberId: string; expiresAt: number }>();

function idempotencyKey(req: FastifyRequest): string | null {
  const k = req.headers['idempotency-key'];
  return (Array.isArray(k) ? k[0] : k) ?? null;
}

/** Namespaced so a key cannot leak between endpoints. */
function scopedKey(req: FastifyRequest, key: string): string {
  return `${req.method}:${req.routeOptions.url ?? req.url}:${key}`;
}

/** Money arriving from a client is untrusted. A 400 the client can act on, not a 500. */
function validateAmountFils(value: unknown): { ok: true; amount: Fils } | { ok: false; message: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: 'amountFils must be a number of fils, e.g. 10000 for 10.000 KD.' };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, message: 'amountFils must be a whole number of fils. 10.000 KD is 10000.' };
  }
  if (value <= 0) {
    return { ok: false, message: 'amountFils must be greater than zero.' };
  }
  return { ok: true, amount: fils(value) };
}

// ------------------------------------------------------------------ member --

app.get('/members/me', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const stamps = has(req, 'stamps');
  const m = stamps ? memberStamps : member;
  if (has(req, 'empty')) {
    // A member who joined today. Note this is combinable: `empty,stamps` is a new
    // member at a stamps salon — zero stamps, not a null tier.
    return {
      ...m,
      balanceFils: 0,
      visits: 0,
      tier: stamps ? null : 'bronze',
      stamps: stamps ? 0 : null,
      joinedAt: new Date().toISOString(),
    };
  }
  return m;
});

app.get('/members/me/transactions', async (req, reply) => {
  if (await intercept(req, reply)) return;
  if (has(req, 'empty')) return { items: [], nextCursor: null };
  return { items: transactions, nextCursor: null };
});

/**
 * The QR token. 45s life, server-minted, single use.
 * The countdown in the UI is cosmetic — rotation and consumption are enforced here.
 */
app.get('/members/me/wallet-token', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const token = `tok_${Math.random().toString(36).slice(2, 12)}`;
  const expiresAt = Date.now() + 45_000;
  liveTokens.set(token, { memberId: member.id, expiresAt });
  return {
    memberId: member.id,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    // Convenience for the client — it should still build this itself.
    uri: walletTokenUri(member.id, token),
  };
});

// ------------------------------------------------------------------ top-up --

app.post('/topups', async (req, reply) => {
  if (await intercept(req, reply)) return;

  const key = idempotencyKey(req);
  if (!key) {
    return reply.code(400).send({
      error: 'idempotency_key_required',
      message: 'Every money-moving POST needs an Idempotency-Key header.',
    });
  }
  const scoped = scopedKey(req, key);
  if (idempotency.has(scoped)) return idempotency.get(scoped);

  const body = req.body as { amountFils: unknown; method: 'knet' | 'card' | 'applepay' };
  const parsed = validateAmountFils(body.amountFils);
  if (!parsed.ok) {
    return reply.code(400).send({ error: 'invalid_amount', message: parsed.message });
  }
  const amount = parsed.amount;
  const method = body.method ?? 'knet';

  // Tier bonus is computed SERVER-SIDE and does not exist in stamps mode.
  const bonusPercent =
    salon.loyaltyMode === 'stamps'
      ? 0
      : (salon.tiers?.find((t) => t.name === member.tier)?.bonusPercent ?? 0);
  const bonus = percentOf(amount, bonusPercent);

  const id = `TI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const intent: TopUpIntent = {
    id,
    memberId: member.id,
    amountFils: amount,
    bonusFils: bonus,
    creditFils: add(amount, bonus),
    method,
    // Merchant-visible, customer-NEVER. Present here so the dashboard lane can
    // build the commission column; the wallet must not render it.
    feeFils: commissionFor(amount, method),
    status: 'created',
    failureReason: null,
    redirectUrl: `http://localhost:${PORT}/_gateway/${id}`,
    reference: `KNET-${Math.floor(Math.random() * 9e7 + 1e7)}`,
  };

  idempotency.set(scoped, intent);
  topups.set(id, intent);
  return intent;
});

/** Authoritative status read. The return URL is a hint; THIS is the result. */
app.get<{ Params: { id: string } }>('/topups/:id', async (req, reply) => {
  if (await intercept(req, reply)) return;

  // Look up the intent that was actually asked for. Returning "whichever intent
  // exists" tells a client polling a fabricated id that their money landed, and
  // makes two concurrent top-ups read each other's amounts.
  const intent = topups.get(req.params.id);
  if (!intent) {
    return reply.code(404).send({ error: 'unknown_topup', message: 'No such top-up.' });
  }

  if (has(req, 'declined')) return { ...intent, status: 'failed', failureReason: 'declined' };
  if (has(req, 'cancelled'))
    return { ...intent, status: 'cancelled', failureReason: 'cancelled_by_user' };
  // pending is its own screen — the client must NOT offer retry from here.
  if (has(req, 'pending')) return { ...intent, status: 'pending', failureReason: null };
  return { ...intent, status: 'succeeded', failureReason: null };
});

/** Stand-in for the gateway hosted page, so the redirect round-trip is real. */
app.get<{ Params: { id: string } }>('/_gateway/:id', async (req, reply) => {
  return reply.type('text/html').send(
    `<!doctype html><meta charset="utf-8"><title>KNET (mock)</title>
     <body style="font:16px system-ui;padding:40px;max-width:34em">
     <h1>KNET — mock gateway</h1>
     <p>Intent <code>${req.params.id}</code>. Pick an outcome; the client must still
     re-read <code>GET /topups/${req.params.id}</code> for the authoritative status.</p>
     <ul>
       <li><a href="avo://topup/return?intent=${req.params.id}">Success</a></li>
       <li><a href="avo://topup/return?intent=${req.params.id}&amp;scenario=declined">Declined</a></li>
       <li><a href="avo://topup/return?intent=${req.params.id}&amp;scenario=cancelled">Cancelled</a></li>
       <li><a href="avo://topup/return?intent=${req.params.id}&amp;scenario=pending">Pending</a></li>
     </ul></body>`,
  );
});

// ------------------------------------------------------------------- staff --

app.post('/staff/session', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const who = has(req, 'noperms') ? staff[1]! : staff[0]!;
  return { token: `staff_${who.id}`, staff: who };
});

app.get('/staff/me', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return has(req, 'noperms') ? staff[1] : staff[0];
});

app.get('/staff', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { items: staff, nextCursor: null };
});

/** Resolve a scanned QR → the member card the scanner shows. */
app.post('/scans', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const { token } = req.body as { token: string };
  const entry = liveTokens.get(token);

  if (!entry) {
    return reply.code(410).send({
      error: 'token_consumed_or_unknown',
      message: 'That code has already been used. Ask the customer to show a fresh one.',
    });
  }
  if (entry.expiresAt < Date.now()) {
    return reply.code(410).send({
      error: 'token_expired',
      message: 'That code expired. Ask the customer to show a fresh one.',
    });
  }

  return {
    member: has(req, 'stamps') ? memberStamps : member,
    heldDepositFils: 0,
    services,
  };
});

/**
 * The one flow to get exactly right. Here it only demonstrates the SHAPE and the
 * failure modes — lane A implements it as one real database transaction per
 * api-contract.md § Charging.
 */
app.post('/charges', async (req, reply) => {
  if (await intercept(req, reply)) return;

  const key = idempotencyKey(req);
  if (!key) {
    return reply.code(400).send({
      error: 'idempotency_key_required',
      message: 'Every money-moving POST needs an Idempotency-Key header.',
    });
  }
  const scoped = scopedKey(req, key);
  if (idempotency.has(scoped)) return idempotency.get(scoped);

  const body = req.body as { memberId: string; serviceIds: string[]; token?: string };

  const requested = body.serviceIds ?? [];
  const chosen = services.filter((sv) => requested.includes(sv.id));
  // An unknown service id must not silently charge 0.000 and settle a real
  // transaction with a voidable window for work that doesn't exist.
  const unknown = requested.filter((id) => !services.some((sv) => sv.id === id));
  if (requested.length === 0 || unknown.length > 0) {
    return reply.code(400).send({
      error: 'invalid_services',
      message:
        unknown.length > 0
          ? `Unknown service: ${unknown.join(', ')}.`
          : 'A charge needs at least one service.',
      unknown,
    });
  }
  const gross = chosen.reduce<Fils>((sum, sv) => add(sum, fils(sv.priceFils)), fils(0));

  // VALIDATE the token here, but do NOT consume it yet.
  if (body.token) {
    const entry = liveTokens.get(body.token);
    if (!entry) {
      return reply.code(410).send({
        error: 'token_consumed_or_unknown',
        message: 'That code has already been used.',
      });
    }
    if (entry.expiresAt < Date.now()) {
      return reply.code(410).send({ error: 'token_expired', message: 'That code expired.' });
    }
  }

  const heldDeposit = fils(0);
  const due = subtract(gross, heldDeposit);
  const balance = has(req, 'lowbal') ? fils(2500) : fils(member.balanceFils);

  if (due > balance) {
    // Nothing else happened — non-negotiable #3. In particular the QR token is
    // still live: she tops up at the counter and the SAME code is rescanned.
    // Burning it here forces her to generate a fresh code after a failure that
    // was never her fault, and it is the exact ordering Lane A must not copy.
    return reply.code(402).send({
      error: 'insufficient_balance',
      shortfallFils: subtract(due, balance),
      balanceFils: balance,
      dueFils: due,
      message: 'Balance too low.',
    });
  }

  // The debit succeeds from here, so the token is consumed as part of it.
  // Real implementation: a conditional UPDATE ... WHERE consumed_at IS NULL
  // returning a row count, inside the charge transaction. A check-and-delete
  // like this one is only safe because Node is single-threaded here.
  if (body.token) liveTokens.delete(body.token);

  const after = subtract(balance, due);
  const tx: Transaction = {
    id: `TX-${Math.floor(Math.random() * 9000 + 1000)}`,
    memberId: body.memberId,
    branchId: BRANCH_SALMIYA,
    kind: 'charge',
    amountFils: fils(-due),
    bonusFils: fils(0),
    method: 'wallet',
    status: 'settled',
    reference: `AVO-CHG-${Math.floor(Math.random() * 9000 + 1000)}`,
    createdAt: new Date().toISOString(),
  };

  const result = {
    transaction: tx,
    balanceAfterFils: after,
    depositAppliedFils: heldDeposit,
    loyalty:
      salon.loyaltyMode === 'stamps'
        ? { mode: 'stamps' as const, stamps: 5, target: salon.stampTarget, rewardReady: false }
        : { mode: 'tiers' as const, visits: member.visits + 1, tier: 'silver', nextTier: 'gold', visitsToNext: 4 },
    /** Voidable for 15 minutes, with a reason. Past that, merchant reimbursement. */
    voidableUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
  };

  idempotency.set(scoped, result);
  return result;
});

app.get('/charges', async (req, reply) => {
  if (await intercept(req, reply)) return;
  // Enforced on the permission, not the UI state.
  if (has(req, 'noperms')) {
    return reply.code(403).send({
      error: 'forbidden',
      message: "You don't have permission to see today's charges. A manager can grant it.",
    });
  }
  return { items: transactions.filter((t) => t.kind === 'charge'), nextCursor: null };
});

app.post('/voids', async (req, reply) => {
  if (await intercept(req, reply)) return;
  if (has(req, 'noperms')) {
    return reply.code(403).send({
      error: 'forbidden',
      message: "You don't have permission to void a charge. A manager can grant it.",
    });
  }
  // A void moves money, so non-negotiable #4 applies to it too. A retried void
  // without a key is a double refund.
  const key = idempotencyKey(req);
  if (!key) {
    return reply.code(400).send({
      error: 'idempotency_key_required',
      message: 'Every money-moving POST needs an Idempotency-Key header.',
    });
  }
  const scoped = scopedKey(req, key);
  if (idempotency.has(scoped)) return idempotency.get(scoped);

  const { reason } = req.body as { transactionId: string; reason: string };
  if (!reason) {
    return reply.code(400).send({ error: 'reason_required', message: 'A void needs a reason.' });
  }

  const result = { ok: true, refundedFils: fils(8000), visitRemoved: true };
  idempotency.set(scoped, result);
  return result;
});

// ------------------------------------------------------------------ salon ---

app.get('/salons/:id', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return has(req, 'stamps') ? { ...salon, loyaltyMode: 'stamps' } : salon;
});

app.patch('/salons/:id', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { ...salon, ...(req.body as object) };
});

app.get('/salons/:id/metrics', async (req, reply) => {
  if (await intercept(req, reply)) return;
  if (has(req, 'empty')) {
    return {
      activeMembers: 0,
      activeMembersDelta: 0,
      loadedTodayFils: 0,
      knetSharePercent: 0,
      repeatRatePercent: 0,
      upcomingAppointments: 0,
    };
  }
  return {
    activeMembers: 1284,
    activeMembersDelta: 48,
    loadedTodayFils: 312500,
    knetSharePercent: 78,
    repeatRatePercent: 62,
    upcomingAppointments: 9,
  };
});

app.get('/salons/:id/artists', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { items: artists, nextCursor: null };
});

app.get('/salons/:id/products', async (req, reply) => {
  if (await intercept(req, reply)) return;
  if (has(req, 'empty')) return { items: [], nextCursor: null };
  return { items: products, nextCursor: null };
});

app.get('/salons/:id/services', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { items: services, nextCursor: null };
});

// -------------------------------------------------------- shared platform ---

/** ONE source of truth — the wallet and the dashboard read this same object. */
app.get('/v1/salons/:id/promotions', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return promotions;
});

app.put('/v1/salons/:id/promotions/boosts', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return {
    ...promotions,
    boosts: (req.body as { boosts: typeof promotions.boosts }).boosts,
    boostsPublishedAt: new Date().toISOString(),
    boostsPublishedBy: 'Noura',
  };
});

/** A merchant cannot send. This only ever creates `pending`. */
app.post('/v1/salons/:id/campaigns', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const body = req.body as Partial<(typeof campaigns)[number]>;
  return {
    ...campaigns[0],
    ...body,
    id: `CMP-${Math.floor(Math.random() * 900 + 100)}`,
    salonId: SALON_ID,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    note: null,
  };
});

app.get('/v1/platform/campaigns', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { items: campaigns, nextCursor: null };
});

/** Published only. The wallet holds no legal copy of its own. */
app.get('/v1/platform/policies', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return { published: policies.published };
});

app.get('/v1/platform/support', async (req, reply) => {
  if (await intercept(req, reply)) return;
  return support;
});

/** Route is resolved HERE from topicId — never taken from the client. */
app.post('/v1/support/tickets', async (req, reply) => {
  if (await intercept(req, reply)) return;
  const body = req.body as { topicId: string; message: string; ref?: string; via: 'wa' | 'email' };
  const topic = support.topics.find((t) => t.id === body.topicId);
  if (!topic) {
    return reply.code(400).send({ error: 'unknown_topic', message: 'Pick a topic from the list.' });
  }
  return {
    id: `SUP-${Math.floor(Math.random() * 90000 + 10000)}`,
    memberId: member.id,
    member: member.name,
    topicId: topic.id,
    route: topic.route, // server-resolved
    message: body.message,
    ref: body.ref ?? '',
    via: body.via,
    at: new Date().toISOString(),
    status: 'open',
  };
});

// ------------------------------------------------------------------- meta ---

app.get('/_health', async () => ({ ok: true, scenarios: 'x-avo-scenario header or ?scenario=' }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`mock API on http://localhost:${PORT} — scenarios via x-avo-scenario`);
});
